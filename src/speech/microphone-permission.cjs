function microphonePermission({ contents, expected, url, permission, details = {}, active }) {
  if (!active || contents !== expected || contents?.getURL() !== url || permission !== 'media') return false;
  if (details.requestingUrl && details.requestingUrl !== url) return false;
  if (details.isMainFrame === false) return false;
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
  return details.mediaType === 'audio';
}
module.exports = { microphonePermission };
