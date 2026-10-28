// Run only by /usr/bin/osascript -l JavaScript. No Automation/System Events permission.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Vision');
ObjC.import('PDFKit');
function run(args) {
  var request = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null)));
  var languages = ['zh-Hans', 'zh-Hant', 'en-US'];
  function recognize(data) {
    var operation = $.VNRecognizeTextRequest.alloc.init;
    operation.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
    var supported = ObjC.deepUnwrap($.VNRecognizeTextRequest.supportedRecognitionLanguagesForTextRecognitionLevelRevisionError(operation.recognitionLevel, operation.revision, null));
    var selected = languages.map(function(language) { return supported.filter(function(item) { return item === language || item.indexOf(language + '-') === 0; })[0]; }).filter(Boolean);
    if (!selected.length) throw Error('No supported OCR language');
    operation.recognitionLanguages = $(selected);
    languages = selected;
    operation.usesLanguageCorrection = false;
    var handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $({}));
    var error = Ref();
    if (!handler.performRequestsError($([operation]), error)) throw Error('Vision OCR failed');
    var observations = operation.results, lines = [];
    for (var index = 0; index < observations.count; index++) {
      var candidates = observations.objectAtIndex(index).topCandidates(1);
      if (candidates.count) lines.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
    }
    return lines.join('\n');
  }
  var pages = [], url = $.NSURL.fileURLWithPath(request.file);
  if (request.pdf) {
    var document = $.PDFDocument.alloc.initWithURL(url);
    if (!document || document.pageCount < 1 || document.pageCount > request.maxPages) throw Error('Invalid PDF page count');
    var numbers = request.pages;
    if (!numbers) { numbers = []; for (var at = 1; at <= document.pageCount; at++) numbers.push(at); }
    numbers.forEach(function(number) {
      if (number < 1 || number > document.pageCount) throw Error('Invalid PDF page');
      var image = document.pageAtIndex(number - 1).thumbnailOfSizeForBox($.NSMakeSize(2400, 2400), $.kPDFDisplayBoxMediaBox);
      pages.push({ page: number, text: recognize(image.TIFFRepresentation) });
    });
  } else pages.push({ page: 1, text: recognize($.NSData.dataWithContentsOfURL(url)) });
  return JSON.stringify({ pages: pages, languages: languages });
}
