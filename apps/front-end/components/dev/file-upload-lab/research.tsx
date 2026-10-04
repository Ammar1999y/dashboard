import { memo } from 'react';

interface Finding {
  text: string;
  /** How the lab or the code answers it. */
  handled: string;
  sources: readonly string[];
}

/*
 * What other browsers do differently, found in their bug trackers and
 * compatibility data (October 2026) instead of tested by hand on devices the
 * owner does not have.
 */
const FINDINGS: readonly Finding[] = [
  {
    text: 'Safari لا يرمّز WebP من canvas: يطلب الكود WebP فيعيد Safari ملف PNG (في جميع الإصدارات حتى الآن، ومنها OffscreenCanvas).',
    handled:
      'prepareFile يجرّب WebP ثم PNG ويُبقي الحد 1 ميجابايت؛ اختبار Bun «a browser that cannot encode WebP» يثبت ذلك، وسيناريو «Safari’s path» يقيس الدقة التي تبقى لصورة كاميرا حقيقية عندما تُحفظ PNG.',
    sources: [
      'https://bugs.webkit.org/show_bug.cgi?id=226950',
      'https://caniuse.com/mdn-api_offscreencanvas_converttoblob_option_type_parameter_webp',
    ],
  },
  {
    text: 'Chrome وFirefox وEdge لا تفكّ HEIC إطلاقًا (لا في img ولا في createImageBitmap ولا canvas)، بينما يفكّها Safari 17 فما فوق على macOS وiOS.',
    handled:
      'سيناريو «a real HEIC» يكتشف قدرة المتصفح نفسه: حيث يُفكّ الملف يُحوَّل، وحيث لا يُفكّ تظهر رسالة تطلب تحويله.',
    sources: ['https://www.testmuai.com/learning-hub/heif-browser-support/'],
  },
  {
    text: 'Safari 17 فما فوق يحوّل صور JPEG وPNG المختارة إلى HEIC باسم مؤقت (tempImage….heic) إذا احتوت قائمة accept على image/heic، على macOS وiOS. لا يوجد إصلاح من Apple.',
    handled:
      'الرفع ينجح لأن Safari 17 يفكّ HEIC، لكن الصورة تُرمَّز مرتين. الحل المعروف هو حذف image/heic من accept في Safari فقط (بفحص نوع المتصفح)، وهو قرار يعود لك.',
    sources: ['https://developer.apple.com/forums/thread/743049'],
  },
  {
    text: 'Safari يلوّث canvas عند رسم SVG يحتوي <foreignObject>، فيفشل التصدير إلى صورة.',
    handled:
      'تحويل SVG ينتهي برسالة «تعذّر التحويل» الواضحة ولا يُرفع SVG؛ سيناريو <foreignObject> يقبل الحالتين ويرفض أي شيء آخر.',
    sources: ['https://bugs.webkit.org/show_bug.cgi?id=119492'],
  },
  {
    text: 'decode() لصورة SVG كان يُرفض في WebKit، وأُصلح في سبتمبر 2019 (r249367)، أي قبل Safari 15 الذي هو أقل إصدار مدعوم هنا.',
    handled: 'renderSvg يستخدم decode() بلا بديل؛ لا يلزم شيء.',
    sources: ['https://bugs.webkit.org/show_bug.cgi?id=201243'],
  },
  {
    text: 'اتجاه EXIF يُطبَّق تلقائيًا عند الرسم في canvas وcreateImageBitmap منذ Chrome 81 وSafari 13.1 وFirefox 77، وكلها أقدم من أهداف المتصفحات هنا.',
    handled:
      'سيناريو «EXIF orientation» يقارن الناتج بالصورة كما يعرضها المتصفح، بصورتين حقيقيتين (اتجاه 6 و3).',
    sources: [
      'https://caniuse.com/css-image-orientation',
      'https://bugs.webkit.org/show_bug.cgi?id=209849',
      'https://bugzilla.mozilla.org/show_bug.cgi?id=1616169',
    ],
  },
  {
    text: 'OffscreenCanvas متاح منذ Safari 16.4 (مارس 2023). في Safari 15 حتى 16.3 تعمل مكتبة الضغط في الخيط الرئيسي، فقد تتوقف الصفحة لحظات مع الصور الكبيرة.',
    handled:
      'المكتبة تنتقل إلى الخيط الرئيسي تلقائيًا فيستمر الرفع؛ سيناريو الصورة 18 ميجابكسل يقيس أطول توقف في هذا المتصفح.',
    sources: [
      'https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas',
      'https://www.npmjs.com/package/browser-image-compression',
    ],
  },
  {
    text: 'iOS يحدّ مساحة canvas بنحو 16.7 ميجابكسل، والصورة المقبولة هنا قد تصل إلى 25 ميجابكسل.',
    handled:
      'مكتبة الضغط تصغّر تحت حد كل متصفح قبل الرسم (approximateBelowMaximumCanvasSizeOfBrowser في مصدرها)؛ صورة الكاميرا في السيناريو 18 ميجابكسل، أي فوق حد iOS.',
    sources: ['https://www.npmjs.com/package/browser-image-compression'],
  },
];

/** Found with real files rather than in browser trackers. */
const REAL_FILE_FINDINGS: readonly string[] = [
  'ملفات SVG كثيرة مُصدّرة حقيقية (منها Illustrator القديم وشعار Wikimedia في السيناريو) تبدأ بسطر <!DOCTYPE svg PUBLIC … svg11.dtd> بلا كيانات، ويرفضها المنقّي المشترك كأنها «ملف SVG غير صالح». الخطر في الكيانات الداخلية فقط؛ قبول DOCTYPE العام بلا قسم داخلي قرار يعود لك في packages/shared.',
  'صورة JPEG حقيقية من كاميرا 10 ميجابكسل (Canon EOS 400D، Montefrío.JPG على Wikimedia Commons) حجمها 5.36 ميجابايت، فيرفضها حد الإدخال 5 ميجابايت للصور قبل الضغط. صور الهواتف الحديثة عالية الدقة قد تتجاوزه أيضًا؛ رفع الحد قرار يعود لك.',
  'خطة SVG في reports/svg-processing-plan.md تقول إن مرجعًا محليًا بكتابة أخرى (#%61) يُحوَّل إلى صورة، لكن الكود واختبار الخادم (#%69) يرفضانه كملف غير صالح. السيناريوهات تتبع الكود.',
];

export const BrowserResearch = memo(() => (
  <section dir='rtl' className='text-start space-y-3'>
    <h2 className='font-semibold'>المتصفحات الأخرى (بحث، لا اختبار يدوي)</h2>
    <ol className='list-decimal ps-6 text-sm space-y-2'>
      {FINDINGS.map(({ text, handled, sources }) => (
        <li key={text} className='space-y-0.5'>
          <p>{text}</p>
          <p className='text-muted-foreground'>{handled}</p>
          <p dir='ltr' className='text-end text-xs'>
            {sources.map((url) => (
              <a
                key={url}
                href={url}
                target='_blank'
                rel='noreferrer'
                className='me-3 text-primary underline'
              >
                {new URL(url).hostname}
              </a>
            ))}
          </p>
        </li>
      ))}
    </ol>
    <h2 className='font-semibold'>ما كشفته الملفات الحقيقية</h2>
    <ol className='list-decimal ps-6 text-sm space-y-1'>
      {REAL_FILE_FINDINGS.map((text) => (
        <li key={text}>{text}</li>
      ))}
    </ol>
  </section>
));
BrowserResearch.displayName = 'BrowserResearch';
