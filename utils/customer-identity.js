function simpleFingerprint(value) {
  const source = String(value || '').replace(/\s+/g, '');
  if (!source) return '';
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) + source.charCodeAt(index);
    hash &= 0xffffffff;
  }
  return `fp_${Math.abs(hash)}`;
}

function maskPhone(phone) {
  const source = String(phone || '').replace(/\s+/g, '');
  if (!source) return '';
  if (source.length < 7) return source;
  return `${source.slice(0, 3)}****${source.slice(-4)}`;
}

module.exports = {
  maskPhone,
  simpleFingerprint
};
