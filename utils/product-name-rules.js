const { numberPattern } = require('./chinese-number');
const { UNIT_PATTERN } = require('./units');

// Narrow lexical compounds: the number describes a shape or a set, not a price
// or a purchase quantity. Other source, date and business checks still apply.
function isCompoundNumericProductName(value) {
  const product = String(value || '').trim();
  const match = product.match(new RegExp(`^(${numberPattern()})(角|件套)([\\u3400-\\u9fffA-Za-z]{0,12})$`));
  if (!match) return false;
  const suffix = match[3];
  if (/^(?:钱|元|毛|分|每|单价|价格|左右|以上|以下|以内|起)/.test(suffix)
    || /(?:要|订|下单|采购|做|买|报|给|发|交)$/.test(suffix)
    || new RegExp(`(?:${numberPattern()})\\s*(?:${UNIT_PATTERN})`).test(suffix)) return false;
  if (match[2] === '件套') return true;
  return /(?:架|钢|铁|尺|桌|板|柱|螺丝|螺母|螺栓|螺钉|扳手|支撑|连接件)$/.test(suffix);
}

function isQuantityOnlyProductName(value) {
  return new RegExp(`^(?:${numberPattern()})\\s*(?:${UNIT_PATTERN})$`).test(String(value || '').trim());
}

module.exports = { isCompoundNumericProductName, isQuantityOnlyProductName };
