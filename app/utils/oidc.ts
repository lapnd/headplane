import { redirect } from '@remix-run/node'
import {
	authorizationCodeGrantRequest,
	calculatePKCECodeChallenge,
	type Client,
	discoveryRequest,
	generateRandomCodeVerifier,
	generateRandomNonce,
	generateRandomState,
	getValidatedIdTokenClaims,
	isOAuth2Error,
	parseWwwAuthenticateChallenges,
	processAuthorizationCodeOpenIDResponse,
	processDiscoveryResponse,
	validateAuthResponse,
} from 'oauth4webapi'

import { post } from '~/utils/headscale'
import { commitSession, getSession } from '~/utils/sessions'

import { HeadplaneContext } from './config/headplane'

type OidcConfig = NonNullable<HeadplaneContext['oidc']>

export async function startOidc(oidc: OidcConfig, req: Request) {
	const session = await getSession(req.headers.get('Cookie'))
	if (session.has('hsApiKey')) {
		return redirect('/', {
			status: 302,
			headers: {
				'Set-Cookie': await commitSession(session),
			},
		})
	}

	const issuerUrl = new URL(oidc.issuer)
	const oidcClient = {
		client_id: oidc.client,
		token_endpoint_auth_method: 'client_secret_basic',
	} satisfies Client

	const response = await discoveryRequest(issuerUrl)
	const processed = await processDiscoveryResponse(issuerUrl, response)
	if (!processed.authorization_endpoint) {
		throw new Error('No authorization endpoint found on the OIDC provider')
	}

	const state = generateRandomState()
	const nonce = generateRandomNonce()
	const verifier = generateRandomCodeVerifier()
	const challenge = await calculatePKCECodeChallenge(verifier)

	const callback = new URL('/admin/oidc/callback', req.url)
	callback.protocol = req.headers.get('X-Forwarded-Proto') ?? 'http:'
	callback.host = req.headers.get('Host') ?? ''
	const authUrl = new URL(processed.authorization_endpoint)

	authUrl.searchParams.set('client_id', oidcClient.client_id)
	authUrl.searchParams.set('response_type', 'code')
	authUrl.searchParams.set('redirect_uri', callback.href)
	authUrl.searchParams.set('scope', 'openid profile email')
	authUrl.searchParams.set('code_challenge', challenge)
	authUrl.searchParams.set('code_challenge_method', 'S256')
	authUrl.searchParams.set('state', state)
	authUrl.searchParams.set('nonce', nonce)

	session.set('authState', state)
	session.set('authNonce', nonce)
	session.set('authVerifier', verifier)

	return redirect(authUrl.href, {
		status: 302,
		headers: {
			'Set-Cookie': await commitSession(session),
		},
	})
}

export async function finishOidc(oidc: OidcConfig, req: Request) {
	const session = await getSession(req.headers.get('Cookie'))
	if (session.has('hsApiKey')) {
		return redirect('/', {
			status: 302,
			headers: {
				'Set-Cookie': await commitSession(session),
			},
		})
	}

	const issuerUrl = new URL(oidc.issuer)
	const oidcClient = {
		client_id: oidc.client,
		client_secret: oidc.secret,
		token_endpoint_auth_method: 'client_secret_basic',
	} satisfies Client

	const response = await discoveryRequest(issuerUrl)
	const processed = await processDiscoveryResponse(issuerUrl, response)
	if (!processed.authorization_endpoint) {
		throw new Error('No authorization endpoint found on the OIDC provider')
	}

	const state = session.get('authState')
	const nonce = session.get('authNonce')
	const verifier = session.get('authVerifier')
	if (!state || !nonce || !verifier) {
		throw new Error('No OIDC state found in the session')
	}

	const parameters = validateAuthResponse(
		processed,
		oidcClient,
		new URL(req.url),
		state,
	)

	if (isOAuth2Error(parameters)) {
		throw new Error('Invalid response from the OIDC provider')
	}

	const callback = new URL('/admin/oidc/callback', req.url)
	callback.protocol = req.headers.get('X-Forwarded-Proto') ?? 'http:'
	callback.host = req.headers.get('Host') ?? ''

	const tokenResponse = await authorizationCodeGrantRequest(
		processed,
		oidcClient,
		parameters,
		callback.href,
		verifier,
	)

	const challenges = parseWwwAuthenticateChallenges(tokenResponse)
	if (challenges) {
		throw new Error('Recieved a challenge from the OIDC provider')
	}

	const result = await processAuthorizationCodeOpenIDResponse(
		processed,
		oidcClient,
		tokenResponse,
		nonce,
	)

	if (isOAuth2Error(result)) {
		throw new Error('Invalid response from the OIDC provider')
	}

	const claims = getValidatedIdTokenClaims(result)
	const expDate = new Date(claims.exp * 1000).toISOString()

	const keyResponse = await post<{ apiKey: string }>(
		'v1/apikey',
		oidc.rootKey,
		{
			expiration: expDate,
		},
	)

	session.set('hsApiKey', keyResponse.apiKey)
	session.set('user', {
		name: claims.name ? String(claims.name) : 'Anonymous',
		email: claims.email ? String(claims.email) : undefined,
	})

	return redirect('/machines', {
		headers: {
			'Set-Cookie': await commitSession(session),
		},
	})
}
