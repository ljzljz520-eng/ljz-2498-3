'use strict';
const crypto = require('crypto');
// 领域 ID 由调用方（页面/客户端）生成时作为稳定幂等键；服务端兜底生成。
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}
module.exports = { newId };
