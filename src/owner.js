/** Single owner is configured explicitly; no sender can claim ownership. */
function get() { return process.env.FEISHU_OWNER_ID || null; }
module.exports = { get };
