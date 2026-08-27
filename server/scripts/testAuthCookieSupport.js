#!/usr/bin/env node

const auth = require('../middleware/auth');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function mockResponse() {
    const calls = [];
    return {
        calls,
        cookie(name, value, options) {
            calls.push({ type: 'cookie', name, value, options });
        },
        clearCookie(name, options) {
            calls.push({ type: 'clearCookie', name, options });
        }
    };
}

function main() {
    const token = 'header.payload.signature';
    const encoded = encodeURIComponent(token);
    const parsed = auth._internal.parseCookieHeader(`other=1; ${auth._internal.AUTH_COOKIE_NAME}=${encoded}; theme=dark`);
    assert(parsed[auth._internal.AUTH_COOKIE_NAME] === token, 'Expected auth cookie parser to decode the auth token');

    const fromCookie = auth._internal.getTokenFromRequest({
        headers: { cookie: `${auth._internal.AUTH_COOKIE_NAME}=${encoded}` }
    });
    assert(fromCookie === token, 'Expected auth token to be read from cookie when bearer header is absent');

    const fromHeader = auth._internal.getTokenFromRequest({
        headers: {
            authorization: 'Bearer header-token',
            cookie: `${auth._internal.AUTH_COOKIE_NAME}=${encoded}`
        }
    });
    assert(fromHeader === 'header-token', 'Expected bearer token to take precedence over cookie token');

    const res = mockResponse();
    auth.setAuthCookies(res, token);
    const secureCookie = res.calls.find(call => call.type === 'cookie' && call.name === auth._internal.AUTH_COOKIE_NAME);
    const markerCookie = res.calls.find(call => call.type === 'cookie' && call.name === auth._internal.AUTH_MARKER_COOKIE_NAME);
    assert(secureCookie, 'Expected login to set auth cookie');
    assert(secureCookie.options.httpOnly === true, 'Expected auth cookie to be HttpOnly');
    assert(markerCookie, 'Expected login to set readable auth marker cookie');
    assert(markerCookie.options.httpOnly === false, 'Expected marker cookie to be readable by the page gate');

    auth.clearAuthCookies(res);
    assert(res.calls.some(call => call.type === 'clearCookie' && call.name === auth._internal.AUTH_COOKIE_NAME), 'Expected logout to clear auth cookie');
    assert(res.calls.some(call => call.type === 'clearCookie' && call.name === auth._internal.AUTH_MARKER_COOKIE_NAME), 'Expected logout to clear auth marker');

    console.log(JSON.stringify({
        success: true,
        checked: 'Bearer-compatible HttpOnly cookie auth support'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
