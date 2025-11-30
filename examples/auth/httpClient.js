/**
 * HTTP Client for Proton API
 * 
 * Creates an authenticated HTTP client that implements the
 * ProtonDriveHTTPClient interface required by the SDK.
 */

const API_BASE_URL = 'https://mail.proton.me/api';

/**
 * Create an authenticated HTTP client for the Proton Drive SDK
 * 
 * @param {ProtonSession} session - Authenticated session
 * @returns {Object} HTTP client implementing ProtonDriveHTTPClient interface
 */
export function createProtonHttpClient(session) {
    const defaultHeaders = {
        'x-pm-appversion': 'web-drive@5.0.0',
        'x-pm-uid': session.uid,
        'Authorization': session.getAuthHeader(),
    };
    
    return {
        /**
         * Make a JSON API request
         */
        async fetchJson(request) {
            const { url, method, headers, timeoutMs, json, signal } = request;
            
            const mergedHeaders = new Headers(headers);
            for (const [key, value] of Object.entries(defaultHeaders)) {
                if (!mergedHeaders.has(key)) {
                    mergedHeaders.set(key, value);
                }
            }
            mergedHeaders.set('Content-Type', 'application/json');
            mergedHeaders.set('Accept', 'application/vnd.protonmail.v1+json');
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);
            
            try {
                const response = await fetch(url, {
                    method,
                    headers: mergedHeaders,
                    body: json ? JSON.stringify(json) : undefined,
                    signal: signal || controller.signal,
                });
                
                return response;
            } finally {
                clearTimeout(timeout);
            }
        },
        
        /**
         * Make a blob/binary API request
         */
        async fetchBlob(request) {
            const { url, method, headers, timeoutMs, body, signal } = request;
            
            const mergedHeaders = new Headers(headers);
            for (const [key, value] of Object.entries(defaultHeaders)) {
                if (!mergedHeaders.has(key)) {
                    mergedHeaders.set(key, value);
                }
            }
            mergedHeaders.set('Accept', 'application/vnd.protonmail.v1+json');
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);
            
            try {
                const response = await fetch(url, {
                    method,
                    headers: mergedHeaders,
                    body,
                    signal: signal || controller.signal,
                });
                
                return response;
            } finally {
                clearTimeout(timeout);
            }
        },
    };
}

/**
 * Make an unauthenticated API request (for login)
 */
export async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE_URL}/${endpoint}`;
    const method = options.method || 'GET';
    
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.protonmail.v1+json',
        'x-pm-appversion': 'web-drive@5.0.0',
        ...options.headers,
    };
    
    const response = await fetch(url, {
        method,
        headers,
        body: options.data ? JSON.stringify(options.data) : undefined,
    });
    
    const data = await response.json();
    
    if (data.Code && data.Code !== 1000) {
        const error = new Error(data.Error || 'API request failed');
        error.code = data.Code;
        error.details = data.Details;
        throw error;
    }
    
    return data;
}

/**
 * Make an authenticated API request
 */
export async function authenticatedApiRequest(session, endpoint, options = {}) {
    const url = `${API_BASE_URL}/${endpoint}`;
    const method = options.method || 'GET';
    
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.protonmail.v1+json',
        'x-pm-appversion': 'web-drive@5.0.0',
        'x-pm-uid': session.uid,
        'Authorization': session.getAuthHeader(),
        ...options.headers,
    };
    
    const response = await fetch(url, {
        method,
        headers,
        body: options.data ? JSON.stringify(options.data) : undefined,
    });
    
    const data = await response.json();
    
    if (data.Code && data.Code !== 1000) {
        const error = new Error(data.Error || 'API request failed');
        error.code = data.Code;
        error.details = data.Details;
        throw error;
    }
    
    return data;
}
