var alloy_data = document.querySelector('#_alloy_data');

var url = alloy_data.getAttribute('url');

var prefix = alloy_data.getAttribute('prefix');

// UTF-8 safe base64 encoding/decoding functions
const utf8_to_b64 = str => {
    try {
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
            }));
    } catch (err) {
        console.warn('UTF-8 encoding failed:', err);
        return str;
    }
};

const b64_to_utf8 = str => {
    try {
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    } catch (err) {
        console.warn('UTF-8 decoding failed:', err);
        return str;
    }
};

url = new URL(b64_to_utf8(url));

// Prevent service worker registration
if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function() {
        return Promise.reject(new Error('Service Worker registration is not supported in proxy mode'));
    };
}

rewrite_url = (str) => {
    try {
        if (!str) return str;
        
        // Handle data: URLs
        if (str.startsWith('data:')) return str;
        
        // Handle absolute URLs
        if (str.startsWith(window.location.origin + '/') && !str.startsWith(window.location.origin + prefix)) {
            str = '/' + str.split('/').splice(3).join('/');
        }
        
        // Handle protocol-relative URLs
        if (str.startsWith('//')) {
            str = url.protocol + str;
        }
        
        // Resolve relative URLs against the base URL
        let absoluteUrl;
        try {
            absoluteUrl = new URL(str, url.href);
        } catch (e) {
            console.warn('URL resolution failed:', e);
            return str;
        }
        
        // Only proxy http/https URLs
        if (absoluteUrl.protocol === 'http:' || absoluteUrl.protocol === 'https:') {
            const encodedUrl = utf8_to_b64(absoluteUrl.href);
            return prefix + encodedUrl;
        }
        
        return str;
    } catch (err) {
        console.warn('URL rewrite failed:', err);
        return str;
    }
}

rewrite_srcset = (srcset) => {
    try {
        if (!srcset) return srcset;
        return srcset.split(',').map(pair => {
            const [pairUrl, size] = pair.trim().split(/\s+/);
            const rewrittenUrl = rewrite_url(pairUrl);
            return size ? `${rewrittenUrl} ${size}` : rewrittenUrl;
        }).join(', ');
    } catch (err) {
        console.warn('Srcset rewrite failed:', err);
        return srcset;
    }
}

try {
    let fetch_rewrite = window.fetch;
    window.fetch = function(url, options) {
        try {
            if (typeof url === 'string') {
                url = rewrite_url(url);
            } else if (url instanceof Request) {
                url = new Request(rewrite_url(url.url), url);
            }
        } catch (err) {
            console.warn('Fetch rewrite failed:', err);
        }
        return fetch_rewrite.apply(this, arguments);
    }
} catch (err) {
    console.warn('Failed to override fetch:', err);
}

try {
    let xml_rewrite = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        try {
            url = rewrite_url(url);
        } catch (err) {
            console.warn('XMLHttpRequest rewrite failed:', err);
        }
        return xml_rewrite.apply(this, arguments);
    }
} catch (err) {
    console.warn('Failed to override XMLHttpRequest:', err);
}

try {
    let setattribute_rewrite = window.Element.prototype.setAttribute;
    window.Element.prototype.setAttribute = function(attribute, value) {
        try {
            if (attribute === 'src' || attribute === 'href' || attribute === 'action') {
                value = rewrite_url(value);
            } else if (attribute === 'srcset' || attribute === 'data-srcset') {
                value = rewrite_srcset(value);
            }
        } catch (err) {
            console.warn('setAttribute rewrite failed:', err);
        }
        return setattribute_rewrite.apply(this, arguments);
    }
} catch (err) {
    console.warn('Failed to override setAttribute:', err);
}

try {
    WebSocket = new Proxy(WebSocket, {
        construct(target, args_array) {
            try {
                if (args_array[0]) {
                    const wsUrl = new URL(args_array[0], url.href);
                    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
                    args_array[0] = protocol + location.host + prefix + 'ws/' + utf8_to_b64(wsUrl.href);
                }
            } catch (err) {
                console.warn('WebSocket proxy failed:', err);
            }
            return new target(...args_array);
        }
    });
} catch (err) {
    console.warn('Failed to override WebSocket:', err);
}

try {
    history.pushState = new Proxy(history.pushState, {
        apply: (target, thisArg, args_array) => {
            try {
                if (args_array[2]) {
                    args_array[2] = rewrite_url(args_array[2]);
                }
            } catch (err) {
                console.warn('pushState rewrite failed:', err);
            }
            return target.apply(thisArg, args_array);
        }
    });
} catch (err) {
    console.warn('Failed to override pushState:', err);
}