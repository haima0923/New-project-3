function sendJson(res, statusCode, payload, origin) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getAllowedOrigin(req, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins === '*') return '*';
  const origin = req.headers.origin || '';
  const list = allowedOrigins.split(',').map((item) => item.trim()).filter(Boolean);
  return list.includes(origin) ? origin : list[0] || '*';
}

module.exports = {
  getAllowedOrigin,
  readJsonBody,
  sendJson
};
