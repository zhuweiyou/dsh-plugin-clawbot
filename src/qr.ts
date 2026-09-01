async function terminalQr(url) {
  try {
    const mod = await import("qrcode-terminal");
    mod.default?.generate?.(url, { small: true });
  } catch {
  }
  process.stdout.write("\u82E5\u4E8C\u7EF4\u7801\u672A\u80FD\u663E\u793A\u6216\u65E0\u6CD5\u4F7F\u7528\uFF0C\u8BF7\u76F4\u63A5\u8BBF\u95EE\u4EE5\u4E0B\u94FE\u63A5\u626B\u7801\uFF1A\n");
  process.stdout.write(`${url}
`);
}
function qrImageUrl(url, template) {
  const tpl = template ?? "https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=__URL__";
  return tpl.replace("__URL__", encodeURIComponent(url));
}
export {
  qrImageUrl,
  terminalQr
};
