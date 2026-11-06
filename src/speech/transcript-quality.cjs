function transcriptQualityIssue(text) {
  // A decoder stuck on a punctuation token must not become a successful
  // transcript, even when an earlier part of the same recording is valid.
  return typeof text === 'string' && /[!！?？。.…]{16,}/u.test(text)
    ? '识别结果包含异常重复标点，离线转写尚未成功。' : null;
}
module.exports = { transcriptQualityIssue };
