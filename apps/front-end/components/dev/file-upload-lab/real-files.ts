/*
 * Files from real cameras, phones and design tools, downloaded when a scenario
 * needs them: pinned URLs (commit SHAs, Commons upload paths) on hosts that
 * answer CORS, checked against their SHA-256 so a changed file fails rather
 * than silently testing something else. The three MIT ones are also in
 * `tests/fixtures/images/` for the Bun tests.
 *
 * If the CSP in `next.config.js` is ever enabled in development, `connect-src`
 * must list these hosts or every download here fails.
 */

export interface RealFile {
  name: string;
  url: string;
  sha256: string;
  /** What a browser declares for it; `''` for HEIC, as Chrome on Windows does. */
  type: string;
  source: string;
}

const GITHUB = 'https://raw.githubusercontent.com';
const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons';

export const REAL_FILES = {
  heicCamera: {
    name: 'IMG_0001.HEIC',
    url: `${GITHUB}/bojand/infer/2e9fead4ef0a99c5bcb4e6aaaa962335e38b9704/testdata/sample.heic`,
    sha256: '546ee3abafcb6d04ede0390e6419cae61e02846d40ac3ddf38cda63a4e5a1dda',
    type: '',
    source: 'bojand/infer (MIT)',
  },
  heicNokiaStill: {
    name: 'autumn.heic',
    url: `${GITHUB}/nokiatech/heif/b05c0aed788dc90b91877ec82df68ee9d48b0fd6/content/images/autumn_1440x960.heic`,
    sha256: '00d9e0636b645036f77b3809fcd26a29df71b9ee66f2865fd8729b894aeabf59',
    type: '',
    source: 'nokiatech/heif conformance content',
  },
  heicNokiaSequence: {
    name: 'starfield.heic',
    url: `${GITHUB}/nokiatech/heif/b05c0aed788dc90b91877ec82df68ee9d48b0fd6/content/image_sequences/starfield_animation.heic`,
    sha256: 'fbf31cd9aa6fc4c997d7eb2ea05541627bf3dbcb4115b7d453f63dcd1ec4fb26',
    type: '',
    source: 'nokiatech/heif conformance content',
  },
  jpegOrientation6: {
    name: 'portrait-6.jpg',
    url: `${GITHUB}/recurser/exif-orientation-examples/9057a78281ca22f5aa28c78ba89db54a487c52a3/Portrait_6.jpg`,
    sha256: 'eb1f8c59199fc7d27361cb1bb9b82cb91f77cc0bd2934be516bcebb2e2eb9d33',
    type: 'image/jpeg',
    source: 'recurser/exif-orientation-examples (MIT)',
  },
  jpegOrientation3: {
    name: 'landscape-3.jpg',
    url: `${GITHUB}/recurser/exif-orientation-examples/9057a78281ca22f5aa28c78ba89db54a487c52a3/Landscape_3.jpg`,
    sha256: 'b151bf11b88398f7358a3a74bf8b7f96b9e436f3d4bb2f86034d1c412039d2d3',
    type: 'image/jpeg',
    source: 'recurser/exif-orientation-examples (MIT)',
  },
  jpegGps: {
    name: 'DSCN0010.jpg',
    url: `${GITHUB}/ianare/exif-samples/2c5ffcbc12545f26e98f58f7a5a41d94bfe8fab9/jpg/gps/DSCN0010.jpg`,
    sha256: '17307b1207eb6487d7908e9d154890b46e3d2e0192369cfd3f4c33d5a5af4035',
    type: 'image/jpeg',
    source: 'ianare/exif-samples (Nikon COOLPIX P6000, GPS)',
  },
  jpegCamera18mp: {
    name: 'camera-18mp.jpg',
    url: `${COMMONS}/d/dd/Jean-Pierre_Brungs_2015-11-01_%28Unsplash%29.jpg`,
    sha256: 'b5bde111edbacff0a278faf4879ab2225f1c973804dc399389c5f0afe0f2b1fc',
    type: 'image/jpeg',
    source: 'Wikimedia Commons, CC0 (Canon EOS 700D, 5184 × 3456)',
  },
  apng: {
    name: 'beach-ball.png',
    url: `${COMMONS}/1/14/Animated_PNG_example_bouncing_beach_ball.png`,
    sha256: '3b28e2462f1b31d0d15d795e6e58baf397899c3f864be7034bf47939b5bbbc3b',
    type: 'image/png',
    source: 'Wikimedia Commons',
  },
  animatedWebp: {
    name: 'animated.webp',
    url: 'https://mathiasbynens.be/demo/animated-webp-supported.webp',
    sha256: 'df1160649539a1f73d4c52043358092c59c584763daf18007ff73b72865ddbc1',
    type: 'image/webp',
    source: 'mathiasbynens.be',
  },
  svgFigmaSqids: {
    name: 'sqids-logo.svg',
    url: `${GITHUB}/sqids/sqids-dotnet/7ac1fe8bfad64a1c81168bda6cb1b1332563ecb7/logo.svg`,
    sha256: '4ecc628edde41fe8cb488ed9e47a80b0cdfb5101f0b0762ef1c010024f286578',
    type: 'image/svg+xml',
    source: 'Figma export, sqids/sqids-dotnet (MIT)',
  },
  svgFigmaSolidus: {
    name: 'solidus-logo.svg',
    url: `${GITHUB}/solidusio/solidus/811ea68bfca8cba8eb02c00d77cf3f564eb6c7b8/logo.svg`,
    sha256: '4a57ee8ba3322ecb14a6560227941abc5e2462d3d4231aa3ce489f7f913d6514',
    type: 'image/svg+xml',
    source: 'Figma export, solidusio/solidus (BSD-3-Clause)',
  },
  svgIllustrator: {
    name: 'fandom-icon.svg',
    url: 'https://cdn.jsdelivr.net/gh/ferdium/ferdium-recipes@006950318f1228af10eeb0cdfb0861af6ecb1e75/recipes/fandom/icon.svg',
    sha256: '06f3a0ff50c81c4225485f02852d2f11a04c18bee40d01b80af8e884fab955f4',
    type: 'image/svg+xml',
    source: 'Adobe Illustrator 28.3 export, ferdium/ferdium-recipes (MIT)',
  },
  svgInkscape: {
    name: 'face-smile.svg',
    url: `${COMMONS}/a/a4/Gnome-face-smile.svg`,
    sha256: 'd930ace80c864256a7b69406db3ffd0196c032a85efb1affa8857f5ee6d10b02',
    type: 'image/svg+xml',
    source: 'Inkscape 0.45, GNOME icon theme via Wikimedia Commons',
  },
  svgInkscapeLogo: {
    name: 'inkscape-logo.svg',
    url: `${COMMONS}/0/0d/Inkscape_Logo.svg`,
    sha256: '8388c6cc93a0e44ba6979c8a6f3273c6bb7860e19208c3c9e9f86057733debc0',
    type: 'image/svg+xml',
    source: 'Wikimedia Commons',
  },
  svgTux: {
    name: 'tux.svg',
    url: `${COMMONS}/3/35/Tux.svg`,
    sha256: 'cd503ad510e16ff2869f959cf57b892bb2175a6874ff696b495bd94fd7db9743',
    type: 'image/svg+xml',
    source: 'Wikimedia Commons (hand-written)',
  },
  svgDoctype: {
    name: 'wikimedia-logo.svg',
    url: `${COMMONS}/8/81/Wikimedia-logo.svg`,
    sha256: 'e4e9e2f72b59b1b86a334557fcc51860aa7743b6829c8075dafb0a93ca8a8415',
    type: 'image/svg+xml',
    source: 'Wikimedia Commons: a public SVG 1.1 DOCTYPE, no entities',
  },
} as const satisfies Record<string, RealFile>;

const downloads = new Map<string, Promise<File>>();

async function download(file: RealFile): Promise<File> {
  const response = await fetch(file.url, { cache: 'force-cache' });
  if (!response.ok)
    throw new Error(`${file.name}: download answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256)
    throw new Error(`${file.name}: the download changed (sha256 ${hex})`);
  return new File([bytes], file.name, { type: file.type });
}

/** Downloaded once per page load; a failure is retried on the next call. */
export function realFile(file: RealFile): Promise<File> {
  const cached = downloads.get(file.url);
  if (cached) return cached;
  const pending = download(file);
  downloads.set(file.url, pending);
  pending.catch(() => downloads.delete(file.url));
  return pending;
}
