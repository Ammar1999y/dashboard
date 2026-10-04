<div dir="rtl">

# مراجعة الأداء واستهلاك الموارد في الـ back-end

**درجات الثقة:**

- **PROVEN:** انعمل probe أو test أو benchmark فعلي.
- **TRACED:** انقرأ مسار الاستدعاء كاملًا، بما فيه كود المكتبات داخل `node_modules`، لكن هذا الوصف وحده لا يعني أن المشكلة أُعيد إنتاجها باختبار.
- **HYPOTHESIS:** فرضية لم يتم التحقق منها.

## ملخص: النتائج الأكثر جدوى للمعالجة

الجدول يحافظ على ترتيب التقرير الأصلي. «تكلفة الإصلاح» تقدير لحجم التعديل، وليست قياسًا لوقت تنفيذه.

| #   | النتيجة                                                                                                                                                     | النوع            | حالة الدليل                                 | تكلفة الإصلاح     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------- | ----------------- |
| 1   | [C-1](#c-1): الـ `session_token` المحدّث يضيع في مسارات Better Auth التي تستخدم `sessionMiddleware`، مثل إعدادات 2FA وpasskeys                              | Cookie           | PROVEN                                      | منخفضة            |
| 2   | [C-2](#c-2): session ملغاة تحصل على 401 دون مسح Cookies في مسارات `requireSession` وBetter Auth، بينما مسارات permissions النظيرة تمسحها                    | Cookie           | PROVEN                                      | منخفضة            |
| 3   | [P-1](#p-1): SQLite WAL auto-checkpoint ينفّذ `fsync` داخل rate limiter ويوقف event loop مدة 5–137 ms، تقريبًا كل 200–250 dashboard request                 | performance      | PROVEN                                      | منخفضة إلى متوسطة |
| 4   | [P-2](#p-2): PostgreSQL prepared statements لا تُحرَّر؛ وتنوّع dashboard filters يزيد ذاكرة PostgreSQL backend بلا حد                                       | resource leak    | PROVEN                                      | منخفضة            |
| 5   | [P-3](#p-3): Better Auth يحذف verifications المنتهية مع كل lookup، وأحيانًا داخل transactions تحمل `FOR UPDATE`، فتنتظر عمليات 2FA للمستخدمين بعضها بعضًا   | runs-too-often   | PROVEN                                      | سطر إعداد واحد    |
| 6   | [P-4](#p-4): كل image upload ينفّذ 5–7 full encodes مع encoder slot واحد لكل process؛ نحو 2.5–2.9 s لصورة 2048 px، والـ upload المتزامن الخامس يحصل على 503 | performance      | PROVEN                                      | منخفضة            |
| 7   | [P-5](#p-5): SVG upload يوقف event loop حتى نحو 0.7 s؛ بسبب JSDOM جديد كل مرة وsvgo multipass                                                               | performance      | PROVEN                                      | منخفضة            |
| 8   | [P-6](#p-6): password + TOTP sign-in يكلّف 73 statement ونحو 85 round trip؛ يمكن تفادي نحو 40% منها                                                         | runs-too-often   | PROVEN                                      | متوسطة            |
| 9   | [C-3](#c-3): المستخدم يغيّر اسمه، لكن الـ session لا تتجدد؛ فيظهر الاسم القديم حتى 5 min                                                                    | Cookie           | PROVEN                                      | بسيطة جدًا        |
| 10  | [P-14](#p-14): timing floor يؤخر verify/reset/complete الناجحة إلى 2.5 s بلا فائدة خصوصية وفق تتبّع التقرير؛ reset كاملة تنتظر 7.5 s ويمكن إزالة 5 s منها   | over-engineering | TRACED؛ أُعيدت مراجعته                      | منخفضة            |
| 11  | [T-1](#t-1): كل test يدفع ≥ 100 ms في drain hooks؛ نحو دقيقتين عبر 1 207 tests، ومع ذلك test يترك background work عالقًا ينجح                               | test quality     | PROVEN في PA2-10؛ أُعيدت مراجعته            | منخفضة            |
| 12  | [P-26](#p-26): Cloudflare purge له «total budget = 25 s»، لكنه يسمح بنحو 45 s على request path                                                              | budget bug       | PROVEN في PA2-07؛ أُعيدت مراجعته            | منخفضة            |
| 13  | [P-27](#p-27): maintenance passes بلا time limit، وتُبقي connection من الـ pool محجوزة طوال R2 retries                                                      | resource         | أثر الـ pool: PROVEN؛ المدة: TRACED؛ PA2-08 | متوسطة            |

---

## 1. صحة Cookies وcaching

بحسب التقرير الأصلي، إصلاح dropped cache cookie السابق يعمل. انقاس end to end مع remember-me وdo-not-remember وsessions التي أكملت 2FA، وعلى dashboard reads وwrites وerror responses وعلى `/get-session`. في كل حالة يُصدر cache Cookie مجددًا لمدة 300 s، والطلب التالي الذي يستخدمه ينفّذ **0 auth queries**. المشكلات التالية من الفئة نفسها، لكن الإصلاح السابق لا يغطيها.

### جدول المسارات: black-box probe لـ 19 route × 9 session states

للقراءة: `+data` تعني إصدار `session_data`، و`+token` تعني إصدار `session_token`؛ والرقم بين القوسين هو `Max-Age` بالثواني. «يمسح» تعني إرسال headers تنهي صلاحية Cookies في المتصفح. وBA اختصار Better Auth. تجاوز `updateAge` يعني أن صف الـ session صار قديمًا بما يكفي ليحتاج refresh؛ لا يعني بالضرورة أن الـ session انتهت.

| فئة المسار                                                                                                     | قراءة الـ session عبر                                  | لا يوجد cache Cookie                | الصف تجاوز `updateAge`                  | الصف محذوف والـ cache ما زال صالحًا  | `Cache-Control`                        |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- | --------------------------------------- | ------------------------------------ | -------------------------------------- |
| Permission GETs: users وusers/:id وroles وpermissions وmedia…                                                  | `authenticatedSession` → `cachedGrants` / `liveGrants` | `+session_data(300)`                | `+token +data`                          | 200؛ Known #5                        | `no-store`                             |
| `users/:id/sessions` و`/openapi.json` مع `forceDB`                                                             | `liveGrants`                                           | `+data`                             | `+token +data`                          | 401، يمسح token وdata وdont_remember | `no-store`                             |
| Permission writes، بما فيها upload grant                                                                       | `authenticatedSession` + `liveGrants`                  | `+data`                             | `+token +data`، حتى مع 422              | 401 مع المسح                         | `no-store`                             |
| مسارات `requireSession`: me/preferences وme/change-* وdash/auth/reauth وأول gate للـ upload                    | `authenticatedSession` + `assertLiveSession`           | `+data`                             | `+token +data`                          | **401، لا يمسح شيئًا**               | `no-store`                             |
| BA: `/get-session`                                                                                             | المكتبة                                                | `+data`                             | `+token +data`                          | 200 من الـ cache                     | `no-store` + `pragma`                  |
| BA: `getSessionFromCtx` في `/reauth/methods`                                                                   | المكتبة                                                | `+data`؛ لا يصدر مع do-not-remember | `+token +data`                          | **401، لا يمسح شيئًا**               | `no-store`                             |
| BA: `use:[sessionMiddleware]`؛ 13 endpoint في `enrolment.ts` و`trusted-device.ts`، وpasskey list/delete/update | library middleware                                     | `+data`؛ لا يصدر مع do-not-remember | **الصف يتمدد 24 h، وtoken Cookie يضيع** | **401، لا يمسح شيئًا**               | `no-store`                             |
| sign-in / sign-out                                                                                             | المكتبة                                                | يصدر token وdata                    | —                                       | sign-out يمسح الثلاثة                | `no-store`                             |
| OPTIONS preflight                                                                                              | —                                                      | —                                   | —                                       | —                                    | لا يوجد؛ `Max-Age 600` و`Vary: Origin` |
| 404 / 405 / 308 / anonymous 401                                                                                | —                                                      | —                                   | —                                       | —                                    | `no-store`                             |

### <a id="c-1"></a>‏C-1. مسارات Better Auth التي تستخدم `sessionMiddleware` تُبقي آخر `Set-Cookie` فقط

**ببساطة:** السيرفر يمدّد الـ session ويجهّز أكثر من Cookie لإرسالها للمتصفح. لكن عند دمج الـ headers، كل Cookie تستبدل التي قبلها. النتيجة أن قاعدة البيانات تقول إن الـ session تجددت، بينما المتصفح لم يستلم تمديد `session_token`.

- **الموقع:**
  - ‏`node_modules/better-call/dist/context.mjs:93`.
  - التطبيق يستخدم هذا النمط في `lib/auth/two-factor/session-endpoint.ts:17,27`.
  - Passkey endpoints: ‏`node_modules/@better-auth/passkey/dist/index.mjs:535,584,636`.
- **المشكلة:**
  - better-call ينسخ response headers الخاصة بالـ middleware باستخدام `responseHeaders.set(key, value)` داخل `forEach`. مع `set-cookie` كل قيمة تستبدل السابقة.
  - في daily refresh، تكتب `setSessionCookie` الـ token أولًا ثم الـ cache. الصف يتمدد 24 h، لكن Cookie المسمّاة `session_token` لا تصل، ولا يتمدد `Max-Age` الخاص بها.
  - ‏`/reauth/methods` يستخدم `getSessionFromCtx` بدل الـ middleware، ويوصل القيمتين؛ وهذه هي control case.
- **الدليل:**
  - ‏`scratchpad/cookies/headers-merge.ts` يطبع: `middleware set: 2 after .set merge: [session_data…]`.
  - ‏`/two-factor/methods` و`/passkey/list-user-passkeys` يظهران `rowSlidBy=24h set=[+session_data(300)]`. أما `/reauth/methods` و`/me/preferences` فيظهران `+session_token(2419200) +session_data(300)`.
- **الأثر:** منخفض وقت المراجعة؛ لأن dashboard read التالية تمدّد الـ Cookie مجددًا. لكن أي middleware لاحق يصدر أكثر من Cookie قد يفقدها بصمت، ولا يوجد ما يكشف ذلك. يذكر التقرير أن better-call 1.4.0 كان أحدث إصدار وقتها.
- **الحالة:** PROVEN.
- **الإصلاح:**
  - استبدال `use:[sessionMiddleware]` في `session-endpoint.ts` باستدعاء `getSessionFromCtx` داخل handler، مع 401 عند غياب الـ session، مثل `/reauth/methods`.
  - في passkey endpoints التابعة للمكتبة: patch لـ better-call بحيث يعمل append لـ `set-cookie`، وإبلاغ upstream.
- **الاختبار:** جعل صف الـ session قديمًا بما يحتاج refresh، وإزالة cache Cookie، ثم استدعاء كل middleware endpoint والتأكد أن response تحتوي `session_token`.

### <a id="c-2"></a>‏C-2. الـ session الملغاة أو الموقوفة تحصل على 401 دون مسح Cookies في مسارين من ثلاثة

**ببساطة:** السيرفر يعرف أن الـ session أُلغيت، لكنه يترك Cookies عند المتصفح. فيظل المتصفح يرسل نسخة تقول إن المستخدم داخل الحساب، فتجد route ترفضه وroute ثانية تقبله من الـ cache. المشكلة أن اكتشاف الإلغاء لا ينعكس على حالة المتصفح.

- **الموقع:**
  - ‏`lib/http/session.ts:78-86`: ‏`requireSession` → `assertLiveSession` يرمي خطأ دون queue للـ Cookies.
  - ‏`lib/auth/path-policy.ts:327-336`: ‏`requireLiveSession` تعيد 401 في before hook.
  - النظير الذي يمسحها: ‏`lib/permissions/checker.ts:333-336`؛ ‏`queueRefreshedSessionCookies` قبل `loginRequired`.
- **المشكلة، عندما يكون الصف محذوفًا والـ cache صالحًا:**
  - ‏`me/preferences` عبر GET وPUT، والـ upload، وكل BA live-session path تعيد 401 دون `Set-Cookie`.
  - Permission writes و`/openapi.json` تعيد 401 مع ثلاث expiry headers.
  - ‏`/get-session` يستمر بإعادة 200 من الـ cache.
- **الأثر:**
  - طوال `cookieCache.maxAge`، أي حتى 5 min، قد ترى الواجهة المستخدم signed in بينما تعيد `me/*` و2FA settings حالة 401.
  - كل request من هذا النوع يدفع مجددًا تكلفة 1–2 queries للـ session الملغاة.
  - **غير متحقَّق منه:** هل تدخل الـ front-end في loop بين login وdashboard خلال هذه الفترة؟
  - منفصل عن Known #5: هنا الخلل غياب مسح Cookies، أما تلك فتتعلق بنافذة القراءة من الـ cache.
- **متصفح واحد وإجابتان، PA2-02:** بعد حذف صف الـ session، أعاد GET لـ `me/preferences` حالة 401 وصفر `Set-Cookie`. ثم أعاد GET لجدول users باستخدام نفس cookie jar حالة **200 من الـ cache الذي بقي صالحًا**. السيرفر اكتشف الإلغاء وترك حالة المتصفح دون تحديث.
- **الحالة:** PROVEN.
- **الإصلاح:**
  - في `requireSession`، التقاط 401 الناتج عن liveness check، واستدعاء `queueRefreshedSessionCookies(ctx.headers)` قبل إعادة رمي الخطأ. هذا query واحدة، في failure path فقط.
  - في `path-policy.ts`، وضع expiry headers داخل `headers` الخاصة بكائن `APIError` نفسه. الـ headers التي يضعها before hook تضيع عند throw؛ لأن `toResponse` تقرأ `e.headers` في `better-call/dist/to-response.mjs:125`.
- **الاختبار:** حذف session rows مع إبقاء cache Cookie، ثم طلب `/me/preferences` و`/two-factor/methods`، والتأكد أن token Cookie وcache Cookie انتهت صلاحيتهما.

### <a id="c-3"></a>‏C-3. المستخدم يغيّر اسمه، لكن الـ session تحتفظ بالاسم القديم

**ببساطة:** الاسم الجديد يُحفظ، لكن نسخة البيانات التي يعتمد عليها المتصفح لا تتجدد. فيظل الاسم القديم ظاهرًا حتى انتهاء الـ cache، وقد يستمر هذا حتى 5 min.

- **الموقع:** ‏`app/api/dash/users/[id]/handler.ts:209-219` → `renameSelf` في `lib/users/edit.ts:67`. لا يوجد استدعاء `refreshSessionCookies`، بينما change-email handlers النظيرة تستدعيه.
- **الدليل:** ‏`scratchpad/cookies/self-rename.probe.test.ts` يعرض `PUT 200 … set-cookie: 0`، و`get-session` بعدها يظل يعرض الاسم القديم.
- **الحالة:** PROVEN.
- **الإصلاح:** إرجاع `cookies: await refreshSessionCookies(ctx.headers)` في self branch؛ بتكلفة query واحدة.
- **الاختبار:** الـ probe المذكور أعلاه.

### <a id="c-4"></a>‏C-4. خطأ 401 داخل `getSession` يتحول إلى 500، وتضيع معه Cookie expiries

**ببساطة:** لو حُذفت الـ session بين قراءتها وتجديدها، المكتبة تعرف أنها لم تعد صالحة. لكن التطبيق يفهم خطأ المكتبة على أنه عطل داخلي، فيعرض 500 بدل 401، ولا يوصل للمتصفح تعليمات مسح Cookies.

- **الموقع:**
  - ‏`lib/permissions/checker.ts:67` لا يلتقط الخطأ.
  - ‏`lib/http/response.ts:153-160` يحوّل كل خطأ ليس `CustomError` إلى 500.
  - جهة المكتبة: الفرع `!updatedSession` في `better-auth/dist/api/routes/session.mjs` يستدعي `deleteSessionCookie`، ثم يرمي `UNAUTHORIZED` ومعه expiry headers على كائن الخطأ.
- **متى يحدث؟** عند حذف صف الـ session بين `findSession` و`updateSession` في refresh request التي تحصل مرة يوميًا.
- **الحالة:** TRACED؛ حالة نادرة.
- **الإصلاح:** داخل `authenticatedSession`، التقاط أخطاء `isAPIError`، ووضع Cookies الموجودة في `e.headers` في الـ queue، وتحويل status إلى 401.

### <a id="c-5"></a>‏C-5. Cookie تالفة باسم `session_data` تجعل القراءات تستخدم permission snapshot المخزنة

**ببساطة:** الكود ينظر إلى وجود اسم Cookie، بدل التأكد أن المكتبة استخدمت cache سليمة فعلًا. حتى قيمة عشوائية قد تجعله يختار permission snapshot القديمة. وبعدها يرسل cache Cookie جديدة، فيمكن أن تتكرر الحالة بدل أن تنتهي وحدها.

- **الموقع:** ‏`lib/permissions/checker.ts:179-194`، الدالة `hasSessionCookieCache`، و`:373-376`، الدالة `resolveGrants`.
- **المعروف سابقًا:** Known #15 تقول إن القراءات تتجاوز database بمجرد وجود Cookie باسم الـ cache، حتى لو كانت expired.
- **الأدلة الجديدة:**
  - لا يلزم أن تكون expired؛ القيمة الحرفية `session_data=garbage` تكفي.
  - الـ response تعيد cache Cookie جديدة وموقّعة، فتستمر الحالة بالتكرار بلا نهاية محددة.
  - ‏`probe3.test.ts`: بعد تعطيل role مباشرة في database عقب sign-in، الطلب يعيد 403 دون Cookie، و**200** مع Cookie التالفة.
  - PA2-01 أعادت إنتاج المشكلة مستقلةً مع تعطيل **user** بدل role. Token فقط: 401. لكن `session_data=broken`، أو `session_data.0=broken` كاسم chunk، أو الـ cache الأصلية بعد clock advance بمقدار 301 s لتنتهي صلاحيتها: **200 في الحالات الثلاث**. الحالات malformed تسجل فشل Better Auth في cache JSON parsing، ومع ذلك تحصل على cache Cookie بديلة.
- **النطاق:** غير متاحة عبر التطبيق وقت المراجعة؛ لأن تعطيل role أو user يحذف sessions في `app/api/dash/permissions/[id]/handler.ts:254` و`lib/users/edit.ts:485`. هذه defence in depth، وليست live bypass مثبتة في مسار التعطيل المعتاد.
- **الحالة:** PROVEN؛ Known #15 مع أدلة جديدة.
- **الإصلاح:** تجعل `authenticatedSession` تُرجع flag يوضح هل جاءت الإجابة فعلًا من الـ cache: أُرسلت cache Cookie ولم تعد `session_data` في `Set-Cookie`. يُستخدم هذا flag لاختيار الفرع بدل اختبار اسم Cookie وحده. الاقتراح neutral على الأداء بحسب التقرير.
- **الاختبار:** إضافة junk-cookie case إلى `tests/integration/permission-database-path.test.ts`.

### <a id="c-6"></a>‏C-6. Private media URLs تتغيّر كل ثانية، والـ objects تحمل `no-store`، فلا يعيد المتصفح استخدام الصور

**ببساطة:** عرض نفس القائمة مرة ثانية قد يعطي كل صورة URL جديدة. ومع `no-store` لا يقدر المتصفح يعيد استخدام النسخة السابقة، فينزّل الصور نفسها مجددًا، والسيرفر يعيد signing لها في كل listing.

- **الموقع:** ‏`lib/media/files.ts:269-275,315-319`؛ كل row تُوقَّع مع كل listing. وأيضًا `lib/r2/client.ts:377-421` و`lib/media/headers.ts:561-562`.
- **الدليل:** ‏`scratchpad/media/bench-presign.ts`: توقيع 100 URL استهلك 104.6 ms من CPU. وتوقيع نفس key بعد 1.1 s أعطى URL مختلفة لأن `X-Amz-Date` تغيّر.
- **الأثر:** كل listing render أو refetch ينزّل كل private image مجددًا، حتى نحو 200 KB للصورة، دون thumbnails. صفحة 100 row قد تعني نحو 20 MB من R2 reads المدفوعة بحسب التقرير، إضافة إلى نحو 1 ms من signing CPU لكل row.
- **الحالة:** PROVEN؛ وقد يكون هذا قرارًا مقصودًا.
- **الإصلاح:**
  - تقريب signing time إلى بداية window، أو memoise للـ URL حسب key وwindow، حتى تبقى URLs متطابقة داخلها.
  - يمكن اختياريًا ضبط cache header للـ signed URL باستخدام `ResponseCacheControl: private, max-age=<window>`. **غير متحقَّق منه:** هل يحترم R2 قيمة `response-cache-control`؟
  - الإبقاء على `no-store` في private media قرار متعلق بالخصوصية.
- **الاختبار:** إذا اعتُمد الاقتراح، signing لنفس private key مرتين داخل window واحدة يعطي نفس URL.

### أمور فُحصت ولم تظهر فيها مشكلة ضمن هذه الفئة

- Cookie delivery عبر table-route adapter المسمّى `withQueuedCookies` تعمل عند النجاح و4xx و401؛ وكل Cookie تصل مرة واحدة.
- ‏`new Headers()` في `localiseAuthError` و`mergeHeaders` في Elysia يحافظان على multiple `Set-Cookie` في Bun 1.4.2.
- ‏`Cache-Control: no-store` موجودة في كل JSON response، بما فيها 4xx و5xx و308 و404 و405 وHEAD.
- كل Cookie mint وclear تمر عبر `createAuthCookie`؛ فتتطابق Path وDomain وSameSite وSecure في الحالتين.
- Public images تحمل `immutable`، وهو آمن هنا لأن keys تحتوي row id، والـ bytes لا تتغيّر. Unpublish وpublic delete يعملان purge؛ أما publish فلا يحتاجها.
- 2FA pending state لا تسرّب live session Cookie، وكل 2FA completion path تصدر cache لمدة 300 s كاملة.
- Limiter responses من نوع 429 و503 ما زالت تمر عبر `withQueuedCookies`.

---

## 2. نتائج الأداء واستهلاك الموارد

### <a id="p-1"></a>‏P-1. auto-checkpoint لملف WAL تنفّذ `fsync` أثناء الطلب وتوقف event loop (PROVEN على Windows)

**ببساطة:** تنفيذ rate limiter سريع عادةً، لكنه أحيانًا ينشغل بمزامنة بياناته مع القرص. أثناء ذلك تنتظر كل الطلبات الأخرى، ولذلك تظهر فترات بطء مفاجئة رغم أن معظم الاستدعاءات سريعة.

- **الموقع:**
  - ‏`lib/sqlite/database.ts:29-39,72-80`: استخدام WAL مع `synchronous=NORMAL`، وترك `wal_autocheckpoint` عند القيمة الافتراضية في SQLite، وهي 1000 صفحة.
  - ‏`lib/rate-limit/store.ts:77-96`: تنفيذ عملية `commit` واحدة لكل قبول يقرره rate limiter.
  - استدعاءات hot path: `lib/http/adapters/elysia.ts:50` و`app.ts:384`، واستدعاء `enforceRateLimit` في كل handler.
- **آلية المشكلة:** مع `NORMAL`، لا تنفّذ عمليات `commit` مزامنة `fsync`؛ تنفّذها checkpoint. يشغّل SQLite auto-checkpoint داخل عملية `commit` التي تجعل WAL يتجاوز 1000 صفحة. وهذه العملية استدعاء متزامن لـ rate limiter عبر `bun:sqlite` على event loop، لذلك تنتظرها جميع الطلبات الجاري تنفيذها.
- **عدد مرات القبول في rate limiter لكل طلب:**
  - مسار جدول لوحة التحكم: 2؛ مرة لكل عنوان IP قبل التحقق من المصادقة، ثم مرة لـ per-user rate limiter.
  - كل طلب إلى `/api/auth/*`، بما فيه `get-session`: 1.
  - مسارات الاسترداد وتسجيل الدخول دون كلمة مرور، المتاحة دون مصادقة: 2–3.
  - الرفع: 4.
- **الدليل:** ‏`scratchpad/infra/bench-variants.ts`، مع 30k عملية قبول لكل صف:

  | الإعداد                     | عمليات/ثانية (`ops/s`) | `p99.9`  | أقصى زمن | استدعاءات تجاوزت 5 ms |
  | --------------------------- | ---------------------- | -------- | -------- | --------------------- |
  | إعداد التطبيق، المفتاح نفسه | 4 642                  | 23.06 ms | 136.8 ms | 72 (بإجمالي 1 862 ms) |
  | `wal_autocheckpoint=0`      | 6 524                  | 1.39 ms  | 9.8 ms   | 4 (27 ms)             |
  | `synchronous=OFF`           | 6 693                  | 1.57 ms  | —        | 9                     |
  | `FULL`                      | 284                    | —        | —        | —                     |
  - عند استخدام `rateLimit()` الفعلي: `p50` يساوي 0.116 ms، و`p99.9` يساوي 26 ms، وأقصى زمن 53–266 ms.
  - تمثّل فترات التوقف 29–42% من إجمالي زمن rate limiter، وهي سبب جميع استجاباته الواقعة في الطرف البطيء من التوزيع.

- **الأثر:** توقف واحد لمدة 5–137 ms لكل نحو 200–250 طلب إلى لوحة التحكم على هذا القرص؛ أي نحو مرة كل 5 s عند 50 طلبًا/ثانية. لم يُقَس ذلك على VPS؛ يجب إعادة تشغيل `bench-variants.ts` هناك.
- **خيارات الإصلاح:**
  - (a) حذف index المذكور في P-1b. يقلّل عدد checkpoints إلى النصف، وبتكلفة بسيطة.
  - (b) ضبط `wal_autocheckpoint=0` على الاتصال المستخدم في الطلبات، وتشغيل `wal_checkpoint(PASSIVE)` من Bun Worker له اتصال مستقل، مع آلية حماية تمنع نمو WAL بلا حد إذا توقف العامل عن العمل.
  - (c) استخدام `synchronous=OFF`. هذا قرار للمسؤول عن المشروع: قد يتلف الملف بعد انقطاع الطاقة، وحينها يعيد rate limiter، المصمم للرفض عند الفشل، الاستجابة 503 على مسارات المصادقة إلى أن يُحذَف الملف.
- <a id="p-1b"></a>**P-1b. index `rate_limit_expires_at` يضاعف الكتابة إلى WAL لكل عملية قبول (PROVEN).**
  - الموقع: `lib/rate-limit/store.ts:30`؛ يوجد `expires_at` دائمًا في قائمة `SET` (`:89-92`)؛ والعمليتان الوحيدتان اللتان تقرآن عبر هذا index هما التنظيف الدوري كل 15 دقيقة وفحص وجود سجلات منتهية (`:99,104-105`).
  - الآلية: يعيد SQLite كتابة مدخلة index كلما وُجد indexed column في قائمة `SET`، حتى عندما لا تتغير قيمته.
  - الدليل: قاس `scratchpad/infra/frames.ts` عدد إطارات WAL لكل عملية قبول: من 2.00 → 1.00 للمفتاح نفسه، ومن 2.51 → 1.28 للمفاتيح المختلفة.
  - تكلفة حذف index على التنظيف: دون index، استغرق حذف 50k صف منتهٍ من أصل 100k صف مدة 630 ms بدلًا من 482 ms، ويستغرق الفحص الذي لا يجد صفوفًا 8 ms بدلًا من 0.5 ms، مرة واحدة كل 15 min.
  - تكلفة الإصلاح: SQLite migration يرفع `RATE_LIMIT_SCHEMA_VERSION`؛ وبعده لا تستطيع deployment image أقدم بدء التشغيل باستخدام وحدة التخزين نفسها.

---

### <a id="p-2"></a>‏P-2. prepared statements لا تُحرَّر مطلقًا؛ وfilters في لوحة التحكم تنشئها دون حد (PROVEN)

**ببساطة:** كل تغيير في filters الجدول قد ينتج صيغة SQL جديدة، والتطبيق يحتفظ بالـ prepared statements الناتجة طوال عمر الاتصال. مع تكرار الاستخدام تتراكم هذه البيانات في الذاكرة ولا تُحرَّر حتى يُستبدَل الاتصال.

- **الموقع:**
  - ‏`db/index.ts:33`: استخدام `new SQL(DATABASE_URL, { max })` مع القيمة الافتراضية لـ`prepare`، وهي `true`، وضبط `maxLifetime` و`idleTimeout` على 0؛ لذلك لا تُستبدَل PostgreSQL backends دوريًا.
  - مصادر نصوص SQL المختلفة:
    - ‏`lib/data-table/params.ts:95-162` و`filter-columns.ts:384`: حتى 20 filter × columns × operators، بأي ترتيب، مع `and`/`or` و10 عناصر للفرز.
    - كل استدعاء `inArray` بطول مختلف: `users/[id]/sessions/handler.ts:369` و`filter-columns.ts:265-295`.
- **الدليل:**
  - ‏`scratchpad/db/prepared-growth.ts`: تنفيذ 5 000 نص مختلف على اتصال واحد جعل `pg_prepared_statements` يساوي 5 101، ورفع ذاكرة backend من 1.5 MB إلى 52 MB.
  - ‏`prepared-filters.ts`: أدّى 1 500 طلب صالح لقائمة المستخدمين، عبر `parseDataTableParams` الفعلي، إلى إنشاء 797 statement؛ ونمت الذاكرة من 1.6 MB إلى 32 MB، أي نحو 38 KB لكل statement.
- **الأثر:** تنمو الذاكرة طوال عمر العملية. يستطيع مستخدم واحد لديه `users.view`، عند حد 60/min، إضافة أكثر من 100 MB/h على VPS صغير. وينمّي الاستخدام العادي الذاكرة ببطء.
- **الإصلاح:** ضبط `maxLifetime` على 1800–3600 s، وربما `idleTimeout` أيضًا، في connection pool الرئيسي. التكلفة هي 18–38 ms في cold planning للـ queries، عند أول queries لكل backend جديد. ينجح `prepare: false` أيضًا، لكن `db/schema.ts:83` يذكر أن encoding `jsonb` يختلف عند `prepare: true`، لذا يحتاج ذلك إلى تحقق مستقل.

---

### <a id="p-3"></a>‏P-3. تنظيف verification records في Better Auth يعمل عند كل بحث، وبعضه داخل transactions لدينا التي تحتفظ بالـ locks (PROVEN؛ رصده مدقِّقان)

**ببساطة:** عندما يتحقق مستخدم من رمز، يشغّل Better Auth أيضًا cleanup لسجلات منتهية تخص مستخدمين آخرين. إذا كانت تلك السجلات مشغولة في transaction أخرى، ينتظر طلب التحقق رغم أن رمزه لا يعتمد عليها.

- **الموقع:**
  - ‏`lib/auth/index.ts:164`: لا يتضمن إعداد `verification` الخيار `disableCleanup`.
  - المكتبة: `better-auth/dist/db/internal-adapter.mjs:753`.
  - يُستدعى من `lib/auth/two-factor/challenge.ts:102,139,286`؛ والاستدعاء الأخير داخل transaction. ويُستدعى أيضًا من `verify-two-factor.mjs:19` في المكتبة، داخل transaction `runPluginVerifier`.
- **آلية المشكلة:** يضيف كل استدعاء `findVerificationValue` query `select … where expires_at < now limit 100`، ثم عملية `delete … where expires_at < now` دون حد لعدد الصفوف المحذوفة.
  - statements الإضافية: 14 لكل `verify-totp`، و4 لكل إرسال OTP، و6 لكل تحقق من OTP.
  - تُنفَّذ اثنتان من عمليات الحذف هذه داخل `withTwoFactorChallengeTransaction`، التي تحتفظ بـ lock `FOR UPDATE` للمستخدم. ولذلك تبقى locks الصفوف المنتهية التابعة _لمستخدمين آخرين_ محتجزة حتى تُثبَّت هذه transaction بـ`commit`.
- **الدليل:** ‏`scratchpad/credentials/otp-and-lock.test.ts`. عندما احتفظت transaction أخرى بـ lock على row منتهٍ لمدة 1 500 ms، استغرق `verify-totp` مدة 1 616 ms، مقابل 159 ms دون ذلك lock.
- **الإصلاح:** استخدام `verification: { modelName: 'verifications', disableCleanup: true }`. التنظيف الليلي في `lib/maintenance/database.ts:328` يحذف الصفوف المنتهية بالفعل.
  - شرط الاعتماد على هذا الإصلاح: أن يفحص كل قارئ `expiresAt`. تفعل ذلك قراءات التطبيق (`challenge.ts:104,140,292`)، وكذلك حالة OAuth (`state.mjs:141`).
  - لا يفحص `verifyTwoFactor` في المكتبة نفسها انتهاء الصلاحية. لكنه لا يُستدعى إلا بعد الفحص في `challenge.ts:292`، ولذلك **يجب الإبقاء على ذلك الفحص**.

---

### <a id="p-4"></a>‏P-4. رفع الصور: 5–7 full encodes خلف encoder slot واحدة (PROVEN)

**ببساطة:** السيرفر يعيد encode للصورة عدة مرات ليبحث عن حجم مناسب، ثم يعالج الصور واحدة بعد الأخرى. لذلك يستغرق رفع مجموعة صور وقتًا طويلًا، وقد تمتلئ queue قبل بدء معالجة بعضها.

- **الموقع:**
  - ‏`lib/media/image/optimize.ts:374-488`: البحث عن مستوى الجودة المناسب.
  - ‏`:490-513`: encoder slot واحدة، وqueue limit 4.
  - ‏`:295-309`: يُعاد decode للصورة الأصلية في كل محاولة.
  - يرسل المتصفح أصلًا صورة WebP بأبعاد تصل إلى 2048 px، وحجم أقل من 1 MiB، وجودة 0.95 (`apps/front-end/utils/images/client-image-compression.ts:22-28`).
- **آلية المشكلة:** عندما تكون الصورة المدخلة WebP بجودة q95 وحجمها يتجاوز الهدف البالغ 200 KB، تُنتج المحاولة الأولى، بجودة q95 والعرض الكامل، حجمًا يقارب حجم الإدخال، ولا يمكن أن تحقق الهدف. ثم يُجرَّب dimension floor، وهو 800 px، ويبدأ binary search.
- **الدليل:** ‏`scratchpad/media/bench-realistic.ts`:
  - صورة 2048×1536: 6 encode attempts في 2 573 ms؛ استغرقت الأولى 559 ms وأنتجت 781 KB.
  - صورة 2048×1365: 7 encode attempts في 2 905 ms.
  - ينفّذ Bun encode على worker threads: استغرق تنفيذ 4 عمليات معًا 1 335 ms، مقابل 998 ms عند تنفيذ 1 فقط. ولذلك فإن encoder slot الواحدة هي ما يحد معدل المعالجة.
  - بقي تأخر event loop عند 2–32 ms؛ لذا لا يوقفها encode.
- **الأثر:** نحو 20–24 عملية رفع صور في الدقيقة لكل عملية تشغيل. إذا اختار مستخدم واحد 6 صور، يحصل على 503 (`processingBusy`).
- **الإصلاح:**
  - تخطي المحاولة الأولى عندما يكون الإدخال WebP/PNG وحجمه أعلى بكثير من الهدف.
  - خيار إضافي: تحسين البحث عن الجودة، للوصول عادةً إلى 2–3 encode attempts.
  - خيار إضافي: استخدام 2 encoder slots. أسوأ حالة تقارب 100 MB من decoded pixels لكل slot؛ وهذا قرار للمسؤول عن المشروع.
  - **لا تُصغِّر الصورة مسبقًا عبر صورة PNG وسيطة.** قاس PA2 هذا البديل ووجده أسوأ: على صورة PNG بدقة 25 MP، استغرق 7.456 s مقابل 5.883 s للمسار الحالي، مع صورة وسيطة بحجم 32.6 MB.
- **المراقبة:** تسجيل `iterations` و`ms` مع كل استدعاء `optimizeImage`. حاليًا لا تُسجَّلان إلا عند الإخفاق في الوصول إلى الحجم المستهدف.

---

### <a id="p-5"></a>‏P-5. رفع SVG يوقف event loop لمدة تصل إلى نحو 0.7 s (PROVEN)

**ببساطة:** معالجة SVG تتم على event loop نفسها التي تخدم بقية الطلبات. ملف واحد بطيء قد يؤخّر تسجيل الدخول والعمليات الأخرى، كما أن تحميل أدوات SVG عند بدء التشغيل يزيد الذاكرة وزمن البدء.

- **الموقع:**
  - ‏`lib/media/image/svg.ts:33` (`sanitizeSvgServer`): إنشاء JSDOM جديد لكل استدعاء، دون إغلاقه مطلقًا.
  - ‏`svg.ts:14`: استدعاء `optimize(data, SVGO_CONFIG)`، حيث يضبط `packages/shared/src/images/svgo-config.ts:8` الخيار `multipass: true`.
  - يُستدعى من `process.ts:126,178`.
  - تعمل عملية sanitize لـ SVG داخل `admitUpload`، قبل فحص megapixel budget، ولا تمر ملفات SVG عبر encoder slot.
- **الدليل:**
  - ‏`bench-svg.ts`: عند حدود الإدخال القصوى، وهي 490 عنصرًا و374 KiB، استغرقت sanitize مدة 284 ms واستغرق `svgo` مدة 431 ms. حتى ملف SVG بحجم 13 KiB استغرق 134 ms.
  - ‏`bench-jsdom.ts`: تكلفة `new JSDOM` هي 24.7 ms لكل استدعاء؛ بينما تكلفة parsing باستخدام window يعاد استخدامها هي 1.7 ms.
  - ‏`bench-svgo-pass.ts`: استغرق `multipass` مدة 834 ms مقابل 322 ms لمرور واحد، مع مخرجات متطابقة.
- **الأثر:** حساب واحد يعمل عند حده البالغ 20/min يشغل event loop لنحو 14 s من كل دقيقة. وتؤدي بضعة حسابات معًا إلى إيقاف جميع المسارات مؤقتًا، بما فيها تسجيل الدخول.
- **الإصلاح:** إعادة استخدام JSDOM window واحدة، وإلغاء `multipass` أو وضع حد له، ما يوفّر نحو 60%، أو نقل العمليتين إلى Bun Worker.
  - إعداد SVGO مشترك حاليًا، ويذكر تعليقه أن المتصفح يشغّله قبل الرفع «حتى يخزّن الطرفان محتوى markup نفسه». ولذلك يجب تعديل `multipass` في `packages/shared`، وهو ما يغيّر الواجهة الأمامية أيضًا؛ وإلا يختل تطابق المعالجة بين الطرفين.
  - بما أن المتصفح حسّن أصلًا الملف المرفوع بالطريقة المشروعة، فمن المرجح أن تستقر معالجة الخادم بعد مرور واحد. تكلفة 0.7 s تخص حالة المهاجم الذي يرسل محتوى markup خامًا مباشرةً إلى API. **غير متحقَّق منه.**
- <a id="p-5b"></a>**أثر بدء التشغيل (P-5b، PROVEN):** يُحمَّل `jsdom` و`svgo` عند بدء التشغيل (`process.ts:22` → `svg.ts:3-4`).
  - القياس: يزيد `jsdom` ذاكرة RSS بمقدار 61.6 MB، ويتطلب 1.3–2.7 s لـ import warm-up؛ ويزيد `svgo` الذاكرة بمقدار 27.8 MB. يبلغ RSS عند بدء التشغيل نحو 175 MB.
  - استيرادهما عند الحاجة يجعل `validateSvgUpload` `async`، وهذا تغيير في عقد الدالة. وحينها يجب أن يظهر فشل import في صورة استجابة 500 واضحة.

---

### <a id="p-6"></a>‏P-6. تسجيل الدخول يتطلب نحو 85 round trip؛ ويمكن تجنب نحو 40% منها (الأعداد PROVEN، والأسباب TRACED)

**ببساطة:** تسجيل الدخول يرسل عددًا كبيرًا من الطلبات إلى قاعدة البيانات، وبعضها يقرأ البيانات نفسها أو ينفّذ عملًا سيُلغى بعده مباشرة. تقليل هذا التكرار يخفّف زمن الدخول واستهلاك connections دون إسقاط فحوص الحالة الحالية.

| المسار                                 | statements | transactions | عدد round trips تقريبًا |
| -------------------------------------- | ---------- | ------------ | ----------------------- |
| تسجيل الدخول بكلمة مرور، دون 2FA       | 13         | 2            | 17                      |
| الخطوة 1 من 2FA (كلمة المرور → التحدي) | 20         | 3            | 26                      |
| الخطوة 2 من 2FA (`verify-totp`)        | 53         | 3            | 59                      |
| **كلمة المرور + TOTP**                 | **73**     | **6**        | **~85**                 |
| إرسال / تحقق OTP في 2FA                | 16 / 39    | 1 / 4        | 18 / 47                 |
| `POST /api/dash/auth/reauth`           | 14         | 2            | 18                      |

- **a.** تُحدَّد بيانات التحدي مرتين في `verify-totp` و`verify-backup-code`: أولًا `path-policy.ts:238` → `challenge.ts:196`، ثم `two-factor/plugin.ts:225,268`. ينتج عن ذلك 11 statement مكررة، تنخفض إلى 7 بعد P-3. الإصلاح: الاحتفاظ بالنتيجة داخل الطلب نفسه في `WeakMap` مفتاحه `ctx.request`؛ مع الإبقاء على عمليتي الفحص.
- **b.** تنشئ الخطوة 1 session ثم تحذفها (`plugin.ts:154-188` → `issue.ts:234,304`؛ ويحدث الشيء نفسه في `passwordless.ts`). يكلف ذلك نحو 7 statements و1 transaction، وضبط اثنين من الـ Cookies ثم مسحهما، وإضافة صف تدقيق `loginSuccess` لـ session لا يتلقاها أحد.
  - الإصلاح: إصدار التحدي قبل إنشاء session.
  - القيد: حينها ستُعاد `EMAIL_NOT_VERIFIED` بعد 2FA بدلًا من إعادتها بعد كلمة المرور. هذا تغيير في العقد، وقراره للمسؤول عن المشروع.
- **c.** تحيط 4 من أصل 6 transactions بـ statement `INSERT` واحدة للـ audit log (`session/hooks.ts:520` و`issue.ts:355` و`challenge.ts:376`). راجع P-9.
- **d.** تنفّذ `readEnrolmentState` 4 queries بالتوازي (`two-factor/methods.ts:121`) عند كل تسجيل دخول بكلمة مرور، بما في ذلك المستخدمون دون 2FA (`issue.ts:178`)، وتُستدعى مرتين لكل عملية تحقق. يجعل ذلك ما يصل إلى 4 من أصل 10 connections في pool قيد الاستخدام لتسجيل دخول واحد. الإصلاح: statement واحدة، أو فحص `users.two_factor_enabled` أولًا.
- **e.** إعادة قراءة صفوف يحتفظ بها الطلب أصلًا:
  - ‏`readVerifiedTotpSecret` (`totp-replay.ts:413`).
  - إعادة `recordPluginCompletion` قراءة صف الحالة (`challenge.ts:416`).
  - إعادة `session.create.after` قراءة البريد الإلكتروني للمستخدم (`hooks.ts:511`).
- **f. استرداد كلمة المرور يقرأ enrolment state مرتين متتاليتين (PA2-05، أُعيد التحقق منه).** يستدعي `app/api/auth/forgot-password/reset/handler.ts:130` الدالة `recoveryDefeatsTwoFactor`، التي تشغّل `readEnrolmentState` (`lib/auth/two-factor/methods.ts:253`). ثم يستدعي `:136` الدالة `readEnrolmentState` مجددًا داخل `tx` نفسها، دون أي كتابة بين الاستدعاءين. بذلك تُنفَّذ 8 statements لقراءة enrolment state، حيث تكفي 4. الإصلاح: جعل `recoveryDefeatsTwoFactor` تستقبل الحالة أو تعيدها.
- **التقدير المتوقع:** ينخفض `verify-totp` من 53 statement إلى نحو 30؛ وتنخفض الخطوة 1 من 20 statement إلى نحو 12–16.
- **ضوابط الإصلاح (PA2):** إعادة استخدام الحالة داخل الطلب الواحد فقط، مع الإبقاء على إعادة الفحص المعتمد داخل transaction. لا تُضَف cache مشتركة بين الطلبات. يجب أن تستمر اختبارات method removal وdeactivation وsingle-use proofs في النجاح.

---

### <a id="p-7"></a>‏P-7. عملية decode للـ session Cookie تكلف 0.7–1.2 ms من CPU time لكل طلب مصادَق عليه (PROVEN)

**ببساطة:** بيانات session داخل Cookie كبيرة لأن التطبيق يحفظ أيضًا permissions غير الممنوحة. في كل طلب يعيد قراءتها ومعالجتها؛ لذا تتراكم تكلفة CPU حتى عندما لا يحتاج إلى query للمصادقة.

- **الدليل:** profile `bun:jsc` لـ3 000 استدعاء `getSession` أصاب cache. يذهب الوقت إلى `base64Decode`، المكتوبة بـJavaScript بالكامل في Better Auth، وإلى `JSON.parse` و`structuredClone` داخل `filterOutputFields` و`importKey`؛ وتزداد تكلفة جميعها مع حجم Cookie.
- **ما يزيد الحجم:** حجم Cookie 1 992 بايت. من الحمولة البالغة 1 494 بايت، تمثّل `metadata` مقدار 744 بايت: boolean grid كاملة لـ4 صفحات × 9 إجراءات، معظمها `false`. تُكتب بواسطة `lib/auth/session/hooks.ts:248-253` و`lib/permissions/session-refresh.ts`.
- **الأثر:** نحو 10% من CPU core واحدة عند 100 طلب/ثانية، ويتضاعف الأثر عند الرفع (P-12).
- **الإصلاح:** تخزين الإجراءات الممنوحة فقط، مثل `{"media":["view","edit"]}`، وقبول الشكلين في `sanitizeCachedPermissions` إلى أن ينتهي استخدام Cookies القديمة. يغيّر ذلك تنسيق permission snapshot.
- **توضيح مرتبط بملاحظة TODO لديك** («فحوص الصلاحيات صارمة وتضغط على قاعدة البيانات»): التكلفة المقاسة للمصادقة على قاعدة البيانات منخفضة أصلًا.
  - القراءة من cache لا تنفّذ أي query مصادقة: 0.
  - عملية الكتابة تنفّذ query `liveGrants` واحدًا يستخدم index، وتكلفته نحو 0.44 ms.
  - يحدث cache miss نحو مرة كل 5 min لكل مستخدم.
  - تخفيف الفحوص سيوفّر قدرًا شبه معدوم؛ تكلفة المعالج هذه هي التكلفة الفعلية للمصادقة في كل طلب.

---

### <a id="p-8"></a>‏P-8. كل transaction تعيد بناء relational config في Drizzle (PROVEN)

**ببساطة:** إعدادات العلاقات في Drizzle ثابتة، لكن التطبيق يعيد حسابها عند كل transaction. هذا يضيف عملًا متكررًا إلى الطلب، ويمكن تجنبه ببناء relational config مرة واحدة.

- **الموقع:** ‏`db/transaction.ts:190`، عبر `drizzle({ client, schema }).transaction(fn, config)`. تشغّل `construct()` (`drizzle-orm/bun-sql/driver.js:15-41`) الدالة `extractTablesRelationalConfig` على جميع الـ36 schema exports.
- **الدليل:**
  - ‏`scratchpad/db/bench-drizzle-ctor.ts`: مدة 171 µs مع schema، مقابل 1 µs دونه.
  - ‏`bench-tx.ts`: يستغرق `withTransaction` مع statement واحدة 597 µs، مقابل 397 µs عندما يُبنى الإعداد مرة واحدة. ويستغرق query عادي مع `autocommit` مدة 188 µs.
- **الأثر:** نحو 0.2 ms من CPU time المتزامن لكل transaction، وهو عمل زائد بالكامل. يتحمل تسجيل الدخول الكامل بكلمة المرور + TOTP هذه التكلفة 6 مرات.
- **الإصلاح:** بناء `extractTablesRelationalConfig(schema)` و`new PgDialect()` مرة واحدة عند module load. ولكل transaction، استخدام `new BunSQLSession(client, dialect, {fullSchema, schema, tableNamesMap}).transaction(fn, config)`؛ فـ`BunSQLSession` مُصدَّرة. يبقى التغليف عبر `cutAt` و`withMembers` كما هو.

---

### <a id="p-9"></a>‏P-9. signature الدالة `auditLog(tx: Tx)` يفرض transaction كاملة حول statement `INSERT` واحدة (التكلفة PROVEN)

**ببساطة:** كتابة audit log مستقل تحتاج إلى INSERT واحد، لكن التصميم الحالي يضيف BEGIN وCOMMIT وحجز connection حوله. السماح بالكتابة مباشرة يزيل هذه التكلفة، مع الإبقاء على transaction عندما يكون السجل جزءًا من تعديل آخر.

- **الموقع:** ‏`lib/audit/index.ts:242`. الاستدعاءات المستقلة موجودة في `lib/auth/session/hooks.ts:157` عند كل تسجيل دخول، و`lib/auth/session/audit.ts:21`، و`lib/auth/two-factor/challenge.ts:376` عند كل إكمال لـ2FA، و`lib/auth/two-factor/plugin.ts:314`.
- **النمط نفسه دون سجل تدقيق:** ‏`lib/auth/two-factor/trusted-device.ts:157` و`lib/auth/path-policy.ts:178`.
- **التكلفة:** حجز اتصال، ثم `BEGIN` و`INSERT` و`COMMIT`، إضافة إلى P-8؛ أي 3 round trips بدلًا من 1: 597 µs مقابل 188 µs على `localhost`.
- **الإصلاح:** قبول `Executor` (`db | Tx`). تستمر عمليات التعديل في تمرير `tx` الخاصة بها، بينما تمرّر الاستدعاءات المستقلة `db`.

---

### <a id="p-10"></a>‏P-10. حذف role يأخذ lock لكل أعضائه الحاليين قبل رفض الحذف بسبب وجود أعضاء (PROVEN)

**ببساطة:** طلب حذف role سيُرفض بسبب وجود أعضاء، لكنه يأخذ أولًا locks على صفوف هؤلاء الأعضاء. نتيجة ذلك قد ينتظر تسجيل دخولهم حتى يكتمل طلب حذف لم يكن قابلًا للنجاح أصلًا.

- **الموقع:** ينفّذ `app/api/dash/permissions/[id]/handler.ts:346-351` lock `FOR NO KEY UPDATE` على جميع الأعضاء؛ ثم يفشل الحذف في `:373-385` باستخدام `hasUsers` إذا كان أي منهم غير محذوف.
- **لماذا لا يفيد lock هنا:** أخذ lock على live members لا يحمي أي شيء. الأعضاء المحذوفون بـ soft delete وحدهم مهمون هنا، بسبب سباق الاستعادة الذي يصفه التعليق.
- **الدليل:** ‏`scratchpad/db/explain-role-delete.ts`، لـ role لديه 875 عضوًا حاليًا:
  - استغرق `LockRows` مدة 72.7 ms، مع `shared hit=2818 dirtied=716`: كتابات فعلية إلى WAL لأخذ lock على 875 صفًا، تعيق استدعاءات `FOR UPDATE` المتزامنة لتسجيل دخول هؤلاء المستخدمين.
  - يستغرق `EXISTS(… deleted_at IS NULL)` دون lock مدة 0.16 ms.
- **العلاقة بـDB-5:** هذه نتيجة إضافية تتجاوز DB-5، التي تتناول `RI seq scan`، ولا تتناول هذا lock.
- **الإصلاح:** فحص وجود live member أولًا دون lock، ورفض الحذف مبكرًا إن وُجد؛ ثم أخذ lock على الأعضاء المحذوفين بـ soft delete فقط. يبقى lock order كما هو.

---

### <a id="p-11"></a>‏P-11. كل بدء تشغيل للـ container يحمّل التطبيق مرتين، ويبني وضع الإنتاج أجزاء OpenAPI لا يقدّمها (PROVEN)

**ببساطة:** قبل تشغيل الخادم، يشغّل container عملية أخرى لتحميل التطبيق وتوليد OpenAPI. ثم يحمّل الخادم التطبيق مرة ثانية؛ لذلك معظم التكلفة الإضافية تأتي من هذا التكرار أكثر من توليد المستند نفسه.

- **الموقع:**
  - يشغّل `CMD` في `Dockerfile` الأمر `bun scripts/build-openapi.ts && exec bun --bun server.ts`.
  - يحتوي `lib/http/openapi/better-auth.ts:46-47` على top-level awaits لـ`generateOpenAPISchema()` و`auth.$context`، ويُحمَّل عبر static import عبر `routes.ts:75` → `openapi/route.ts:9` → `document.ts`. في الإنتاج، لا تقرأ `resolveOpenApiDocument` إلا الملف المُولَّد مسبقًا.
- **الدليل:** تستغرق عملية `build-openapi` مدة 3.6–6.6 s، مقابل نحو 2–2.7 s لاستيراد `app.ts`. المولِّد نفسه يستغرق 26–95 ms، وOpenAPI modules تستغرق 25–80 ms.
- **الإصلاح:** استخدام dynamic import لـ `./document` داخل المولِّد الذي يحتفظ بنتيجته لإعادة استخدامها، وتوليد الملف داخل العملية نفسها قبل `listen` بدلًا من توليده في عملية ثانية. تحتفظ مرحلة `verify` في Dockerfile بفحص التطابق.
- **مرتبط بالنتيجة، لكن خُفِّضت أهميته:** يعيد `/openapi.json` تحويل مستند حجمه 223 KB إلى نص JSON عند كل طلب؛ ويمكن الاحتفاظ بالنص في cache.

---

### <a id="p-12"></a>‏P-12. الطلب الواحد يبحث عن session عدة مرات (PROVEN؛ رصده ثلاثة مدقِّقين)

**ببساطة:** التطبيق يحدّد المستخدم، ثم تعود طبقات أخرى داخل الطلب نفسه لتبحث عن session والصلاحيات مرة ثانية وثالثة. إعادة استخدام النتيجة داخل الطلب تقلّل هذا العمل المتكرر.

- **الرفع:**
  - يستدعي `app/api/upload/file/handler.ts:43` الدالة `requireSession`، التي تنفّذ `getSession` و`assertLiveSession`.
  - ثم يستدعي `:46` الدالة `requireAnyPermission`، التي تنفّذ `getSession` مرة أخرى، و`liveGrants` التي تفحص session row أصلًا.
  - يضيف الرفع العام `requirePublishGrant` (`lib/media/upload.ts:533` و`lib/media/policy.ts:66`): استدعاءً ثالثًا لـ`getSession` واستدعاءً ثانيًا مطابقًا لـ`liveGrants`.
  - القياس: 2 statements عند وجود cookie cache، و4 دونه، و6 للرفع العام دونه.
  - الإصلاح: استخدام `authenticatedSession` في `:43`، لأن المطلوب فقط هو الحفاظ على أولوية إرجاع 401، وإعادة استخدام الصلاحيات التي أُعيدت بالفعل لفحص `media.publish`. والأفضل الاحتفاظ بنتيجة `authenticatedSession` لكل كائن `Headers` خاص بطلب في `WeakMap`، وهو النمط الذي تستخدمه `queuedCookies` بالفعل، مع إبقاء `refreshSessionCookies` بلا cache.
  - تغير في حالة طرفية: session التي أُلغيَت، مع cookie cache ومورد غير معروف، ستتلقى 400 بدلًا من 401.
- **مسارات فحص session الحالية في Better Auth:**
  - ينفّذ `lib/auth/path-policy.ts:276-280,347-368` الدالة `findSession`، التي تضم المستخدم إلى query أصلًا. ثم تعيد `assertLiveSession` (`session/live.ts:63`) قراءة الصف نفسه، وتقرأه middleware في المكتبة مرة ثالثة.
  - القياس: ينفّذ `/two-factor/methods` 3 statements مع cache صالحة، اثنتان منها الفحص نفسه؛ وينفّذ `/reauth/methods` 5 statements.
  - تتحمل do-not-remember sessions هذه التكلفة في كل طلب، ولا تحصل على cache مطلقًا.
  - الإصلاح: query واحد لفحص session الحالية بواسطة session token، يفحص أيضًا `users.is_active` و`deleted_at` وانتهاء الصلاحية.
- **الاختبار:** تأكيد ألا يتجاوز الطلب استدعاءً واحدًا لـ`getSession` وquery واحد لـ session row، باستخدام عدّاد أداة القياس.

---

### <a id="p-13"></a>‏P-13. فحص reauth window ينفّذ 4 queries متتابعة (PROVEN)

**ببساطة:** قبل قبول عملية حساسة، يقرأ التطبيق عدة مصادر ليتأكد أن reauth window ما زالت صالحة. هذه queries تعمل بالتتابع، ويُعاد الفحص أحيانًا داخل transaction التعديل، ما يطيل وقت الانتظار والاحتفاظ بالـ lock.

- **الموقع:** ‏`lib/auth/reauth/window.ts:74-106` مع `lib/auth/reauth/methods.ts:14-34`: بحثان في verification records، ثم query للحسابات وquery للـ passkeys يعيدان فحص أن الوسيلة المستخدمة ما زالت متاحة.
- **ما الذي يحمي منه آخر 2 queries:** لا توجد عملية تضبط `accounts.password` على null، وإزالة factor تلغي النوافذ أصلًا عبر `revokeTwoFactorState`. تبقى حالة مستخدم يحذف آخر passkey لديه لا يُعد factor، داخل نافذة مدتها 15 دقيقة أنشأها بنفسه.
- **التكلفة:** نحو 2.2 ms لكل عملية كتابة يشترط تنفيذها وجود reauth window. يعيد `lib/users/edit.ts:147` الفحص مرة ثانية داخل transaction التعديل، ولذلك يبقى lock محتجزًا مدة أطول.
- **الإصلاح:** query واحد: `identifier IN (…)` مع queries فرعية تستخدم `EXISTS`، وفحص الوسيلة المسجَّلة فقط.

---

## 3. تعقيد زائد وrace guards مكلفة

### <a id="p-14"></a>‏P-14. الـ timing floor يؤخّر نتائج verify الناجحة أيضاً

**ببساطة:** المستخدم الذي أدخل الرمز الصحيح ينتظر وقتاً إضافياً رغم أن نجاحه أثبت امتلاكه للرمز. التأخير مطلوب في send حتى لا يكشف وجود الحساب، لكن فائدته لا تمتد تلقائياً إلى verify الناجح. قبل إزالة التأخير، يجب التأكد من عدم وجود وضع يسمح بالنجاح دون الرمز.

- **الحالة:** TRACED؛ أُعيد التحقق.

- **الموقع:**
  - ‏`lib/http/timing-floor.ts:96-98`: تنتظر كتلة `finally` تنفيذ `ensureMinDelay` في كل النتائج، بمجرد تشغيل `startFloor`.
  - ‏`MINIMUM_RESPONSE_MS` = 2 500 ms.
  - مواضع الاستدعاء: `app/api/auth/otp/verify/handler.ts:60`، و`forgot-password/reset/handler.ts:102`، و`forgot-password/complete/handler.ts:72`، و`lib/auth/passwordless.ts:216-219`.
- **لماذا لا يخفي هذا التأخير معلومات إضافية؟** النجاح يتطلب الرمز الصحيح أو grant صالحاً؛ ولذلك لا يرى من يحاول اكتشاف الحسابات نتيجة نجاح. تأخير مسارات _send_ ضروري، لأن استجابة النجاح فيها عامة. أما تأخير _verify_ الناجح فلا يحقق الغرض نفسه.
- **التكلفة:** password reset ينتظر 7.5 s إجمالاً، ويمكن إزالة 5 s منها. وpasswordless login ينتظر 5 s، ويمكن إزالة 2.5 s منها. كل request يبقى منتظراً يحتفظ بـsocket وtimer، لكنه لا يحتفظ باتصال بقاعدة البيانات.
- **توثيق قديم:** يذكر `timing-floor.ts:34-35` أن `/forgot-password/complete` غير مشمول (`not covered`)، مع أن الـhandler يستدعي `startFloor()`.
- **الإصلاح:** إضافة `padSuccess: false` لمسارات verify، ونقل `ensureMinDelay` إلى كتلة `catch` في `passwordless.ts`. يظل الشرط الأمني «المعرّف المعروف لا يجيب بزمن أطول من المعرّف غير المعروف» محفوظاً. ويختبر `tests/integration/otp-timing-oracle.test.ts` تأخير مسارات send فقط، ولذلك لن يتعطّل بهذا التغيير.
- **قرار المسؤول:** هذه نقطة تمس الأمان. يجب التأكد من أن النجاح في جميع مسارات verify المذكورة يتطلب الرمز؛ بما في ذلك مثلاً وضع `OTP_AUTO_VERIFY`، الذي سبق التنبيه إليه في `should-ignore #61`.

### <a id="p-14b"></a>‏P-14b. قد يمكن خفض الـ timing floor لمسارات anonymous send عن 2.5 s

**ببساطة:** الرد على send قد لا يحتاج الآن إلى انتظار 2.5 s كاملة. لكن تغيير القيمة المشتركة مباشرة قد يقلّل أيضاً الوقت المتاح للتحقق من رمز صحيح، فيُرفض بسبب البطء. المطلوب قياس زمن send وتخصيص قيمة له، مع إبقاء الرد على الحساب الموجود وغير الموجود متساوياً.

- **الحالة:** PA2-06؛ tuning، مع القياس أولاً.

- **الموقع:** ‏`lib/http/timing-floor.ts:37`، حيث `MINIMUM_RESPONSE_MS = BUSY_TIMEOUT_MS + KNOWN_BRANCH_WORK_MS`، وsend orchestration في `lib/otp/anonymous-send.ts`.
- **الدليل المقاس في PA2:** أجابت passwordless sends إلى وجهات unknown، ثم known، ثم unknown، بالحالة 200 عند 2 507.4 و2 503.2 و2 504.5 ms، على الترتيب.
- **لماذا قد يمكن خفضه؟** بُني الـfloor على كامل retry budget للـSQLite writer، وهو 2 000 ms. لكن الـlimiter ينتظر الآن تحرير lock دون blocking، عبر `admitWindowWithoutBlocking` في `lib/rate-limit/store.ts:158`، ويستمر send issuance بعد إرسال الرد. لذلك لم يعد response floor في send مضطراً إلى مساواة كامل retry budget.
- **لماذا لا يُخفض دون قياس؟** في مسارات verify، تحدد الـconstant نفسها work deadline للـtransaction، أي `floorDeadline`. خفضها دون قياس p99 لعمليات verify مشروعة قد يؤدي إلى رفض رموز صحيحة. لا يوجد حتى الآن دليل يحدد قيمة آمنة.
- **الإصلاح:** تخصيص floor مستقل لمسارات send، يُحدد من قياس pre-response p99 على الـVPS. يجب إبقاء ردود known وunknown متساوية في التوقيت.
- **الاختبار:** مقارنة timing distributions للحالتين known وunknown مع بطء PostgreSQL وSQLite contention.

### <a id="p-15"></a>‏P-15. حذف private file ينفذ purge للـpublic URL، فيصبح private delete معتمداً على Cloudflare

**ببساطة:** حذف private file يرسل إلى Cloudflare عملاً غير لازم، رغم أن التعامل مع الـpublic copy انتهى عند تغيير visibility. هذا يستهلك حصة purge، وقد يجعل الحذف ينتظر Cloudflare أو يعيد `pending`.

- **الحالة:** TRACED؛ أُعيد التحقق.

- **الموقع:**
  - ‏`lib/media/lifecycle.ts:137-163`: تحذف `finishDeleting` الـkey من كل bucket مفعّل، ثم تنفذ purge لكل key أبلغ الـpublic bucket عن حذفه.
  - ‏`lib/r2/client.ts:233-261`: مع `Quiet: true`، تُبلغ R2 عن الـkey غير الموجود بأنه محذوف، ولذلك يصل كل row إلى `publicGone`.
- **لماذا لا يلزم purge للـprivate row؟** لا تُزال transition marker للـrow إلا بعد أن تحذف `removeObject` النسخة المقابلة وتنفذ purge لها، وفق `lib/media/visibility.ts:169-182,278,309`.
- **الأثر:**
  - استدعاء واحد لـCloudflare API لكل 30 private file، أثناء معالجة request من نوع DELETE أو folder delete.
  - تستهلك هذه الاستدعاءات حصة purge البالغة 900 استدعاء لكل 5 دقائق؛ وهي الحصة التي تقول التعليقات إنه يجب إبقاؤها متاحة لحذف الملفات لأسباب تتعلق بالخصوصية.
  - عند تعطل Cloudflare أو نفاد الحصة، تعيد private deletes الحالة `pending`، عند `:162`.
- **الإصلاح:** تنفيذ purge فقط للـrows التي تحقق `bucketType === 'public'`، مع الاستمرار في الحذف من الـbuckets الاثنين.
- **الاختبار:** حذف private row عند تفعيل إعداد purge يجب ألا يستدعي `purgeUrls`.
- **التداخل مع P-26:** حذف private folder يحوي 200 ملف ينشئ 7 purge batches غير لازمة. ومع بطء Cloudflare، قد تستغرق كل batch حتى 20 s داخل الـroute.

### <a id="p-26"></a>‏P-26. الـpurge الموثّق بـ«total budget قدره 25 s» يسمح باستمرار الاستدعاء نحو 45 s

**ببساطة:** الكود يفحص الوقت قبل بدء batch، لكنه يمنح retries داخلها وقتاً جديداً حتى لو اقتربت الـbudget من نهايتها. لذلك مدة الانتظار الفعلية قد تتجاوز الـ25 s الموثّقة. الاختبار سجل 40 s، والآلية تفسّر كيف يمكن أن تقترب المدة من 45 s.

- **الحالة:** PA2-07؛ PROVEN باستخدام fake clock؛ أُعيد التحقق.

- **الموقع:** ‏`lib/cloudflare/purge.ts:25`، حيث `TOTAL_BUDGET_MS`؛ و`:135-137`، حيث لا يُفحص الـdeadline إلا قبل بدء batch؛ و`:70-111`، حيث `purgeBatch` تستخدم `ATTEMPTS = 2`، ولكل attempt ‏`AbortSignal.timeout(10_000)`.
- **مواضع الاستدعاء أثناء معالجة request:** ‏`lib/media/lifecycle.ts:143`، لحذف ملف أو مجلد، وكذلك `:280`.
- **الآلية:** batch تبدأ عند 24.9 s تحصل مع ذلك على محاولتين جديدتين، مدة كل منهما 10 s، فتبلغ الحالة الأسوأ نحو 45 s. وإذا حدث التجاوز في آخر batch، فلن يظهر log ‏`deadline reached`، لعدم وجود batch لاحقة تُلغى بسبب انتهاء الوقت.
- **الدليل من PA2:** عند تشغيل `purgeUrls` الفعلية على 31 URL، مع mock للـfetch يستغرق كامل الـtimeout، بدأت attempts عند 0 و10 000 و20 000 و30 000 ms، وكانت النتيجة `elapsedMs: 40000, failed: 31`.
- **الأثر:** تظل المدة ضمن `timeoutSeconds: 120` لمسارات media، في `routes.ts:96`. لكن الـbudget الموثّقة غير صحيحة، وقد يبقى folder delete منتظراً نحو 45 s عند بطء Cloudflare. أما single-file unpublish فيظل ضمن 20 s.
- **الإصلاح:** تمرير absolute deadline إلى `purgeBatch`، وتقييد timeout لكل attempt بالوقت المتبقي، وعدم بدء أي attempt بعد الـdeadline. تظل URLs التي لم يتأكد نجاح purge لها ضمن `failed`.
- **الاختبار:** fake clock و31 URL، مع بدء batch قرب الـdeadline. يُتحقق من الحد الأقصى للمدة ومن عدم بدء أي attempt بعد الـdeadline.

### <a id="p-16"></a>‏P-16. الـpre-auth IP limiter أغلى من العمل الذي يحمي منه

**ببساطة:** معظم requests غير الموثّقة تُرفض دون الوصول إلى قاعدة البيانات أصلاً، لكن الـIP limiter ينفذ كتابة لكل منها. تكلفة هذه الكتابة أعلى من فحص session في الحالات المقاسة، وتضيف ضغطاً على SQLite. تبسيطها ممكن، لكنه يغيّر قواعد قبول requests.

- **الحالة:** PROVEN.

- **الموقع:** ‏`lib/http/adapters/elysia.ts:50`، و`app.ts:384`، و`lib/http/pre-auth.ts:208-219`. تضبط `routes.ts:98-112` الخيار `preAuth: 'ip-limit'` لكل dashboard route، ثم تضيف الـhandlers ‏per-user limiter.
- **ما الذي يقيّده فعلياً؟** anonymous request أو request ذو forged Cookie لا يصل إلى قاعدة البيانات. تُعيد Better Auth القيمة `null` عند فشل HMAC، في `better-auth/dist/api/routes/session.mjs:40-47`. ولذلك فإن database path الذي يقيّده هذا الـlimiter فعلياً هو إعادة استخدام stale Cookie ما يزال توقيعه صالحاً.
- **الدليل:** ‏`scratchpad/pipeline/bench3.ts`:
  - تكلفة limiter write عند p50 هي 88–104 µs، مقابل 47–95 µs لـ`getSession` دون Cookie أو مع forged Cookie.
  - بقية الـpipeline تكلف نحو 20 µs.
  - تسهم كل كتابة أيضاً في checkpoint stalls المذكورة في P-1.
- **خيارات الإصلاح:** احتساب request في هذا الـlimiter فقط عند وجود session-token Cookie، أو إبقاء pre-auth counter في process memory. كلا الخيارين يغيّر admission invariant؛ القرار يعود للمسؤول.
- **ملاحظة مرتبطة، خُفّضت أهميتها:** تحمل anonymous recovery وpasswordless routes الـpre-auth بحد مشترك يبلغ 120/min، فوق per-handler IP limits أشد تبلغ 30–60/min. أما المساران النظيران `otp/send` و`otp/verify` فيستبعدان pre-auth لهذا السبب تحديداً، وفق `routes.ts:160-161`.

### <a id="p-17"></a>‏P-17. guards أصغر تكلف نحو round trip إضافية لكل منها

**ببساطة:** بعض guards تعيد أخذ lock أو قراءة بيانات حُمّلت بالفعل، فتضيف انتظاراً دون فائدة واضحة. توجد أيضاً فرص لتقليل requests إضافية، لكن بعضها يحتاج إلى تحقق كما هو موضح أدناه.

- **الحالة:** TRACED.

- ‏`lib/otp/send.ts:123`: تنفيذ `pg_advisory_xact_lock` مباشرة بعد `lockUser FOR UPDATE` عند `:119`، في upsert يستخدم `ON CONFLICT`. الـuser lock يضمن بالفعل تنفيذ sends لذلك المستخدم بالتتابع.
- ‏`lib/otp/verify.ts:227`: يعيد daily-usage ‏`SUM` قراءة الـunique row الذي قُفل بالفعل عند `:125`. يمكن اختيار تلك columns في أول query.
- ‏`app/api/dash/users/[id]/handler.ts:133`: تعيد `actorCoversTargetRole` قراءة `role_permissions` التي حُمّلت بالفعل عند `:97-103`. يمكن تمرير `userData.role.rolePermissions` إلى `assertRowsWithinScope` بدلاً من ذلك.
- ‏`app/api/dash/permissions/[id]/handler.ts:165`: تقرأ `validateRolePermissionScope` الـrows باستخدام `FOR SHARE` ثم تتخلّص من النتائج؛ وتقرأها `:202-208` مرة أخرى. الـ`FOR SHARE` زائد في وجود `FOR UPDATE` على role.
- ‏`lib/media/visibility.ts:249-272`: تنفيذ HEAD بعد COPY عند publish وunpublish. قد تجعل ETag في COPY response طلب HEAD غير ضروري؛ **لم يُتحقق من أن R2 تعيدها**. الـroute محدود بـ10/min، لذلك الأولوية منخفضة. التعليق في `publish/handler.ts:258` قديم.
- ‏`db/transaction.ts:102-116`: تنتظر `cutAt` تنفيذ `set_config` قبل كل statement، بتكلفة تقارب 150 µs لكل statement، وذلك في `lib/otp/verify.ts:84` فقط. **لم يُتحقق من إمكان pipelining مع `bun:sql`**.

### <a id="p-18"></a>‏P-18. `lib/cache` عبارة عن scaffold غير مستخدم، لكنه يُفتح ويخضع للـsweep رغم ذلك

**ببساطة:** مهمة الصيانة تنشئ cache database لا يستخدمها التطبيق بعد، ثم تحتفظ باتصال مفتوح بها. وجود cache scaffold وحده لا يستدعي تشغيل صيانته قبل أن يبدأ استخدامه.

- **الحالة:** PROVEN؛ اكتشفه مدقّقان.

- **الموقع:** تستدعي `lib/maintenance/sqlite.ts:37,53,67` الدالتين `cacheSweepExpired` و`cacheHasExpiredRows` كل 15 دقيقة. يؤدي ذلك إلى استدعاء `getStore()` في `lib/cache/index.ts:165-171`، فتُنشأ `cache.db` وملفاها `-wal` و`-shm`، ويظل الاتصال مفتوحاً، رغم أن الوحدة تحمل الوصف `SCAFFOLD: no call site uses this yet`.
- **الدليل:** طبع `scratchpad/infra/bench-sweep.ts` النتيجة `cacheDbCreatedBySweep: true`.
- **الإصلاح:** تجاهل store لم يُفتح سابقاً، باستخدام `lazyStore.isOpen()`، أو إزالة الـjob إلى أن يوجد caller للـcache.

---

## 4. ملاحظات أخرى عن استهلاك الموارد

### <a id="p-19"></a>‏P-19. OAuth

**ببساطة:** توجد كلفتان مختلفتان: إعادة جلب signing keys عند كل callback بدل مشاركتها، وtoken exchange قد يبقى منتظراً بلا timeout يوقف request فعلياً. الأولى تضيف requests وزمناً، والثانية قد تترك اتصالاً خارجياً عالقاً.

- **الحالة:** PROVEN في كلا التدقيقين؛ صُنّفت مشكلة token exchange بدرجة Medium في PA2-03.
- **Google signing keys:** تنشئ `lib/auth/oauth/id-token.ts:74-76` كائناً جديداً من `createRemoteJWKSet` وتفرض `reload()` في كل callback. يؤدي ذلك إلى فقد freshness cache في jose، وفقد مشاركة concurrent fetches.
  - **الدليل:** في PA2-04، باستخدام RS256 tokens حقيقية وstub JWKS server يضيف 30 ms، نفذت ستة استدعاءات للـverifier الحالي **6** JWKS requests خلال 195.4 ms؛ بينما نفذ shared resolver واحد **1** request خلال 34.0 ms.
  - **الإصلاح:** resolver واحد على مستوى module، دون forced `reload`. تعيد jose الجلب عند مواجهة `kid` غير معروف. يجب الحفاظ على التمييز بين invalid token وunavailable keys، وألا تُخزّن keys مؤقتاً إلى الأبد.
- **Token exchange:** ‏`oauth/plugin.ts:388-389` → `@better-auth/core/dist/oauth2/validate-authorization-code.mjs:64` → `betterFetch`، دون abort signal.
  - **الدليل:** ظل `scratchpad/credentials/fetch-timeout.ts` منتظراً بعد 15 s أمام server لا يجيب إطلاقاً. وفي PA2، تأخرت provider response داخل real harness flow مدة 5 500 ms، دون أن يُلغى outgoing signal.
  - يحتفظ هذا الانتظار بالـrequest والـoutbound socket وبـstate سبق استهلاكه، لكنه لا يحتفظ باتصال بقاعدة البيانات.
  - **الإصلاح:** abortable deadline باستخدام `AbortSignal.timeout(5000)`، تشمل أيضاً قراءة response body. استخدام `Promise.race` للعودة مبكراً فقط سيترك request مستمراً.
  - **الاختبار:** provider لا يرسل headers إطلاقاً، وآخر يرسل body ببطء على دفعات. يُتحقق من actual abort ضمن الحد المحدد.

### <a id="p-20"></a>‏P-20. قراءات `db` المباشرة تنتظر connection من الـconnection pool بلا حد زمني؛ أما transactions فتتوقف عن الانتظار بعد 10 s

**ببساطة:** قد يبقى request منتظراً قبل أن يبدأ query أصلاً، لأن كل connections مشغولة. حد مدة query لا يعالج هذا الانتظار؛ المشكلة هي الحصول على connection من الـpool.

- **الحالة:** PROVEN.
- **الموقع:** ‏`db/transaction.ts:33-60` تضع time limit للحصول على connection في `withTransaction` فقط.
- **الدليل:** في `scratchpad/db/pool-wait.ts`، ومع pool من 2 connections محجوزين كليهما، تلقت transaction استجابة 503 عند 1 005 ms، بينما أجابت plain read عند 3 821 ms.
- **الأثر:** عند pool saturation، كما في AUTH-6 أدناه، تبقى read routes منتظرة بدلاً من الفشل سريعاً.
- هذه نقطة مستقلة عن PG-1، التي تتعلق بمدة query، لا بانتظار connection. لا يوجد driver-level fix قليل التكلفة: البديل هو app-level semaphore، أو إصلاح AUTH-6 بحيث نادراً ما يصل pool إلى saturation.

### <a id="p-21"></a>‏P-21. Cloudflare purge يرسل URL واحداً لكل API call في sweeps

**ببساطة:** معالجة backlog رابطاً وراء رابط تستهلك حصة Cloudflare سريعاً، رغم أن API تسمح بتجميع URLs في طلب واحد.

- **الحالة:** TRACED.
- تُستدعى `lib/media/orphaned-objects.ts:21-41` لكل row من `sweepOrphanedObjects` عند `:122`، ومن `retryTransitions` في `visibility.ts:339-381`. قد يستهلك backlog من 1 000 row حصة 900 استدعاء لكل 5 دقائق في sweep واحدة. تقبل API ‏30 URL في كل call، ولذلك يجب تجميعها في batches.

### <a id="p-22"></a>‏P-22. audit INSERT واحدة لكل row داخل locked transactions

**ببساطة:** كتابة audit events واحداً تلو الآخر تطيل وقت الاحتفاظ بالـlocks. إدخالها معاً يقلل round trips أثناء حجز lock.

- **الحالة:** TRACED.
- **الموقع:** ‏`lib/media/lifecycle.ts:244-255`، لما يصل إلى 200 row مع الاحتفاظ بـ`FOR UPDATE`؛ و`:366-372`، لما يصل إلى 200 row تحت global tree advisory lock؛ و`lib/media/files.ts:203-211`، لـ50 row؛ و`lifecycle.ts:86-93`.
- **التكلفة:** بافتراض 1 ms لكل round trip، يحتفظ أكبر folder delete بالـtree lock مدة إضافية قدرها 0.2–0.4 s.
- **الإصلاح:** إضافة `auditMany` تكتب multi-row insert واحدة.

### <a id="p-23"></a>‏P-23. round trips إضافية صغيرة

**ببساطة:** بعض العمليات تقرأ ما أدخلته للتو، وبعض queries تعمل بالتتابع رغم إمكان تنفيذها جنباً إلى جنب. تقليل هذه الخطوات قد يقلل وقت انتظار الرد.

- **الحالة:** TRACED.
- تعيد entity uploads قراءة insert التي نفذتها للتو، في `upload.ts:495-501`؛ يمكن استخدام `returning`.
- ينفذ `GET /api/dash/media` عمليات `requireFolder` وrows وbreadcrumbs بالتتابع، في `app/api/dash/media/handler.ts:117,119,161`.
- تُنفذ `searchFolders` بعد files query، بدلاً من التنفيذ بالتوازي معها.

### <a id="p-24"></a>‏P-24. SMTP يفتح connection جديدة لكل OTP email

**ببساطة:** إذا كان كل email يبدأ connection من الصفر، فقد يدفع المستخدم تكلفة تجهيز الاتصال مع كل إرسال. هذه فرضية تحتاج إلى قياس، واستخدام pool يجب ألا يفسد إيقاف socket عند انتهاء timeout.

- **الحالة:** HYPOTHESIS.
- **الموقع:** ‏`lib/smtp.ts:104,132`، و`lib/otp/delivery.ts:124`. كل send يتحمل تكلفة DNS وTCP وTLS وAUTH أثناء معالجة request في authenticated send paths.
- **التحقق المقترح:** قياس الزمن أمام TLS loopback مع `pool: true`. استخدام pooled transport يجعل الحفاظ على صحة socket destroy عند الـdeadline أصعب. الأولوية منخفضة عند حجم الاستخدام الحالي.

### <a id="p-25"></a>‏P-25. إعدادات Argon2

**ببساطة:** الإعدادات الحالية تستهلك وقتاً حسابياً ملحوظاً، والبدائل المقاسة تنفذ hashes أكثر في الثانية. تخفيف الكلفة قرار أمني أيضاً، وتُقرأ الأرقام مع مراعاة تذبذب القياسات ودور pepper.

- **الحالة:** PROVEN، مع noisy measurements؛ القرار يعود للمسؤول.
- تستخدم `lib/auth/password/hash.ts:194` القيم m=64 MiB وt=3 وp=4، وهي library defaults: ‏116–327 ms لكل hash، و6–13 hashes/s لكل process.
- بدائل OWASP: ‏m=46 MiB وt=1 وp=1 تعطي 31–48 hashes/s؛ وm=19 MiB وt=2 وp=1 تعطي 52–71 hashes/s.
- عند 16 concurrent hashes، ساوت p=1 أداء p=4 أو تفوقت عليه.
- يحمي pepper بالفعل من database-only leak؛ لذلك خفض الكلفة يضعف offline guessing فقط عندما يتسرّب pepper أيضاً.

### <a id="p-27"></a>‏P-27. maintenance passes بلا time limit، وتحتفظ بـreserved pool connection طوال كل remote retry

**ببساطة:** بطء R2 قد يجعل maintenance job تحتفظ بجزء من connections قاعدة البيانات وقتاً طويلاً. وقد تتداخل معها job أخرى، بينما تبقى health checks ناجحة لأنها تستخدم pool منفصلة. الاختبار أثبت استهلاك connections؛ مدة 75 دقيقة ناتجة عن تتبع حدود retries في الكود.

- **الحالة:** PA2-08؛ PROVEN لتكلفة pool؛ TRACED للمدة.
- **الموقع:** ‏`lib/maintenance/election.ts:27-38`: تحجز `runElected` connection من main pool، وتحتفظ بـadvisory lock طوال `await run()`.
- **الحلقات الداخلية:** ‏`lib/media/reconcile.ts:24,166`، لما يصل إلى 200 HEAD لكل bucket؛ و`lib/media/visibility.ts:52,319`، لـ1 000 transition retry؛ و`lib/media/orphaned-objects.ts:15,122`، لـ100 orphan delete.
- يسمح كل R2 call بـ`maxAttempts: 3` × `R2_REQUEST_TIMEOUT_MS = 15 000`، في `lib/r2/client.ts:50,68`.
- **الآلية:** لا شيء يحد زمن pass كاملة. عند تعليق R2، تعادل 100 عملية فاشلة × 3 attempts × 15 s نحو **75 min**، ويظل أحد connections العشرة محجوزاً طوالها.
- **التداخل:** تعمل retention عند 03:30 UTC، وتعمل Sunday reconcile عند 04:00 UTC. إذا تجاوزت retention مدة 30 دقيقة، تتداخل jobs وتحجزان 20% من pool.
- **الدليل من PA2:** أظهر تعليق اثنين من `runElected` callbacks وجود advisory locks اثنين في PostgreSQL. نجحت 8 ordinary reservations، وانتهى timeout للـreservation رقم 9 عند 101.98 ms مع abort مضبوط على 100 ms.
- **لماذا لا تكشف health checks ذلك؟** تستخدم `health/storage` الـprobe pool المنفصلة، فتظل ناجحة.
- **الإصلاح:** elapsed budget لكل pass، والتوقف بعد N consecutive identical timeouts، مع إبقاء durable markers للتشغيل التالي، وتمرير abort إلى R2 calls. ويمكن اختيارياً تخصيص small separate pool للـelections. يجب الحفاظ على election وtransition ownership guards؛ لا توجد فائدة آمنة ومثبتة لإزالتها.
- **المراقبة:** job start time وage، وليس completion فقط؛ وconnection acquisition latency؛ وremote timeout streaks.

### <a id="p-28"></a>‏P-28. retention تُبلغ بـ«no backlog» بعد تخطي locked overdue rows

**ببساطة:** تخطي rows المحجوزة بـlock يسمح للمهمة بالعمل، لكنه لا يعني أنها أنهت كل ما يستحق الحذف. الإبلاغ بأن لا شيء متبقٍ يخفي backlog ويؤخر retry حتى الليلة التالية.

- **الحالة:** PA2-09؛ PROVEN؛ أُعيد التحقق.
- **الموقع:** ‏`lib/maintenance/database.ts:160`: تؤدي `deleted < BATCH_SIZE` إلى `hasMore: false`، مع استخدام `.for('update', { skipLocked: true })` عند `:195`.
- **الآلية:** قد تعني batch صغيرة أن rows جرى تخطيها لأنها locked، لا أنه لم يعد شيء متبقٍ. ينطبق النمط نفسه على generic expiry sweeps وverification sessions.
- **الدليل من PA2:** مع حجز expired session واحدة بـ`FOR UPDATE`، أعادت sweep الفعلية `{status:"ok", hasMore:false, sessions:{removed:0}}`، مع `eligibleRemaining: 1`. وأزالتها دورة ثانية بعد تحرير lock.
- **الأثر:** ينتظر العمل حتى الليلة التالية، ويبقى backlog alert المعتمد على `hasMore` صامتاً. هذه monitoring and retention gap، وليست unsafe deletion.
- **الإصلاح:** الإبقاء على `SKIP LOCKED`. وبعد pass، تنفيذ bounded probe يسأل «هل بقي أي overdue row؟»، أو الإبلاغ عن backlog بأنها `unknown`، لتُتاح retry في وقت أقرب.

---

## 4ب. نتائج تخص test harness (مدمجة من PA2-10)

جودة test harness مهمة تحديدًا لفئة الأخطاء التي سألتم عنها: خطأ قد يصل إلى النشر لأن «لا شيء كان سيمنع مروره».

### <a id="t-1"></a>‏T-1. الـ drain hooks تضيف ≥ 100 ms لكل test، وفشل drain لا يُفشِل test

**ببساطة:** كل test ينتظر حتى لو لم يكن هناك أي عمل لتنظيفه. وإذا بقي after-response work عالقًا، ينتهي الانتظار لكن test يظل ناجحًا؛ ثم يبدأ تنظيف mocks بينما العمل السابق لم ينتهِ، وقد يؤثر ذلك في test التالي.

- **الحالة:** PROVEN في PA2؛ أُعيد التحقق منه.

- **الموقع:**
  - ‏`tests/helpers/preload-base.ts:130-135` (`beforeEach`) و`:153-162` (`afterEach`): كلاهما يستدعي `drainAfterResponse(5000)` ويتجاهل النتيجة المنطقية.
  - ‏`lib/http/after-response.ts:93,112-114`: حتى مع queue فارغ، ينتظر `AFTER_RESPONSE_SETTLE_MS = 50` للتأكد من استقرار العمل وعدم وجود أعمال تُسجَّل متأخرًا.
- **الدليل والكلفة:**
  - استغرق 100 زوج من drain على queue فارغ 10 177 ms في PA2. يحتوي المستودع على نحو 1 207 حالة من `test(` و`it(`؛ أي نحو **دقيقتين** من الانتظار وحده في كل full run متسلسل، بغض النظر عما يتحقق منه كل test.
  - إذا بقي after-response work معلّقًا، يستخدم كل hook كامل budget البالغ 5 s، ومع ذلك ينتهي test بنتيجة **1 pass, 0 fail** مع pending work = 1. أُثبت ذلك في PA2 باستخدام `stranded-work.test.ts`.
  - تعمل resets الخاصة بـ mocks المشتركة (`resetEgress` و`resetMailbox` و`resetObjectStore`) بعدها بينما العمل السابق لم ينتهِ، وقد يؤثر ذلك في test التالي.
- **الإصلاح:**
  - يفشل test عندما يعيد drain القيمة `false`، ولا تُنفَّذ resets على mocks المشتركة قبل استقرار العمل.
  - توفير مسار قليل الكلفة لـ pure unit tests: تخطّي انتظار 50 ms عندما لا يكون هناك request أو deferred work أُنشئ.
  - إبقاء ضمان الاستقرار في production shutdown. التحقق من `pendingAfterResponse() === 0` وحده قد يفوّت أعمالًا تُسجَّل لاحقًا.
- **الاختبار المقترح:** test لـ harness في child process يترك after-response work معلّقًا دائمًا ويتحقق من exit code غير صفري؛ وtest ثانٍ يغطي late registration.

### <a id="t-2"></a>‏T-2. أحد retention tests لا يختبر السلوك الفعلي

**ببساطة:** test يفتعل خطأ محليًا ثم يلتقطه بنفسه. لذلك نجاحه لا يثبت أن scheduled callback الحقيقي يعالج الفشل أو يسجّله أو يستمر في العمل.

- **الحالة:** أُعيد التحقق منه.

- **الموقع:** ‏`tests/integration/retention-sweep.test.ts:763`؛ عنوان test يفيد بأن sweep الذي يرمي خطأ يُحتوى، ويُسجَّل حسب فئة الخطأ، ولا يؤدي إلى rejection.
- **الدليل:** يلف test دالة محلية ترمي خطأ داخل `try {} catch {}` خاص به. لا يستدعي production scheduled callback، ولا يتحقق من أي log.
- **الإصلاح:** استخدام injected scheduled job يفشل فعلًا، ثم التحقق من failure event الحقيقي ومن استمرار scheduling.

---

## 5. مسائل معروفة ظهرت بشأنها أدلة جديدة

هذه المسائل مسجَّلة بالفعل في `reports/should-ignore.md` أو `TODO.md`. لم تُدرج من جديد إلا عندما ظهر دليل إضافي.

- **TODO C-027 / AUTH-6: تنفيذ Argon2 داخل login transaction.** توجد مواضع إضافية بالنمط نفسه:
  - Dash reauth يحتفظ بقفل `FOR UPDATE` على user row لمدة 167 ms.
  - ‏`totp/start`، عبر `reauth/password.ts`، يحتفظ به لمدة 107 ms.
  - محاولة بكلمة مرور خاطئة تحتفظ به لمدة 125 ms.
  - ‏`app/api/dash/users/me/change-password/handler.ts:94` يحمل النمط نفسه. التعليق الذي يفيد بأن «Argon2 يبقى خارج mutation transaction» صحيح فقط بالنسبة إلى transaction الثانية.
  - ‏`db/limits.ts:20-25` يوثّق بالفعل احتفاظًا بالقفل لمدة 4.6 s. ينبغي أن يشمل الإصلاح المخطَّط جميع هذه المواضع.
- **Known #15:** راجع [C-5](#c-5). قيمة Cookie غير صالحة تفعّل المشكلة أيضًا، وليس فقط Cookie منتهية الصلاحية، ويستمر إصدار Cookie من جديد دون نهاية.
- **should-ignore #25:** الملاحظة «`checkMultiplePermissions` يستخدم اثنتين من DB round trips» أصبحت قديمة. وفق query count الذي أجراه session auditor، يستخدم الآن واحدة فقط. يمكن إزالة هذه الملاحظة.
- **Known #13: خصم OTP budget أثناء الاحتفاظ بـ PG locks.** يشرح P-1 الآلية وراء مدة التعطيل المقاسة البالغة 2 282 ms. أي limiter commit قد يكون هو الذي ينفّذ checkpoint، بما في ذلك الخصم داخل OTP transaction.
- **TODO: Bun precompile / single binary.** توجد حاليًا الأدلة التالية ضد إعطاء ذلك الأولوية:
  - per-request pipeline overhead نحو 20 µs.
  - يستهلك boot time وقتًا في تشغيل jsdom وsvgo وaws-sdk وbetter-auth؛ bundling لا يزيل هذا العمل.
  - يفشل plain bundle مبني باستخدام `bun build --target=bun` أثناء runtime عند `require("../data/patch.json")` في css-tree، ثم عند `Cannot find module '../package.json'`.
  - تعتمد `openApiArtifactFile()` في تحديد المسار على `import.meta.dir`، الذي يشير إلى virtual filesystem داخل compiled binary.
  - يُنصح بتنفيذ P-11 وP-5b أولًا.

---

## 6. جوانب فُحصت ولم تظهر فيها مشكلة

هذه نتائج الفحوص المذكورة في التقرير ضمن بيئته ونطاقه. وتبقى الأمور التي لم تُختبر مذكورة في القسم 8.

- **Pipeline:**
  - overhead نحو 20 µs لكل request، وفق 404 p50.
  - access-log line واحد بالضبط لكل request، بما في ذلك early 413 وHEAD.
  - يبقى `Content-Length` موجودًا بعد Elysia response rebuild.
  - تستخدم WeakMaps المفاتيح الصحيحة لـ cookie queue وafter-response queue وtiming.
  - يُبنى OpenAPI document وcompiled lookups مرة واحدة.
  - ‏`lib/env.ts` و`lib/startup.ts` و`lib/id.ts` تنفّذ boot-time work فقط.
- **Session:**
  - cached read ينفّذ 0 auth queries.
  - sliding refresh يكتب مرة واحدة يوميًا لكل session.
  - تعديل role يحدّث كل sessions التابعة له في `UPDATE` واحدة؛ ولا تعمل drift-repair transaction عندما يكون row مواكبًا للحالة الحالية.
  - ‏`forceDB` لا يفعل شيئًا على non-read actions.
- **Credentials:**
  - تُوضَع library after-hooks في queue حتى ما بعد commit، فلا يُفتح connection ثانٍ من connection pool داخل auth transaction.
  - تُحلَّل pepper وOTP keyrings مرة واحدة.
  - timing floors لا تحتفظ بأي connection.
  - استدعاءات Turnstile وSMS وWhatsApp لها timeouts.
  - password-proof map لها حد لعدد العناصر.
- **Database:**
  - users list: ‏1–9 ms عند وجود 50 ألف users، بما في ذلك page 200.
  - trigram search يستخدم كلا GIN indexes.
  - roles وpermissions lists تعمل في أقل من 1 ms.
  - كل detail GET ينفّذ relational query واحدة.
  - ‏`auditLog` تستهلك 67 µs من CPU لكل call.
  - لا تعمل migration عند boot.
  - user create وadmin edit ينفّذان hash خارج transaction.
  - probe pool يعمل بآلية single-flight وله `statement_timeout` مستقل.
  - فحص PA2 دقة session timestamps، واستبعد truncation المشتبه به في session cursor ‏`(createdAt, id)`. هذه نتيجة التدقيق الثاني؛ لم يُعَد تشغيل الفحص في التدقيق الحالي.
- **Media:**
  - لا يوجد HEAD قبل PUT.
  - يُنشأ S3 client مرة واحدة، مع connect timeout مقداره 3 s وrequest timeout مقداره 15 s.
  - لا يوجد double checksum.
  - upload buffers لا تُنسَخ: بقي RSS ثابتًا خلال `formData` → `arrayBuffer` → `Buffer.from`.
  - decoding يقرأ headers فقط أثناء حجز slot.
  - Office detection له حدود واضحة.
  - folder recursion له depth limit.
  - لا توجد N+1 queries.
  - ‏`health/storage` لا يتصل بـ R2 أبدًا.
  - reconcile يعمل أسبوعيًا، وحجم العمل له حدود.
    - **توضيح:** المقصود هنا حدود عدد العناصر أو عمق المعالجة، وليس total time budget؛ يوضح [P-27](#p-27) غياب هذا الحد الزمني.
- **Infrastructure:**
  - hot statements تُحضَّر مرة واحدة.
  - sweep يسمح للـ event loop بتنفيذ أعمال أخرى؛ وعند 20 ألف rows كانت أطول event-loop gap تساوي 10 ms.
  - كلفة writer-lock وownership machinery تكاد تكون معدومة وقت runtime في single process، إذ لا توجد owner timers. تكون elections قليلة الكلفة عندما يكون job خاملًا، لكن ليس عندما يعلق في remote calls؛ راجع P-27.
  - shutdown لا يترك موارد متسرّبة.
  - limiter الخاص بـ Better Auth معطَّل.
  - ‏`ipIdentifier` تستغرق 0.35 µs لكل call.

---

## 7. tests ومراقبة خفيفة لاكتشاف هذه المشكلات مبكرًا

**ببساطة:** الفكرة هي تثبيت ما يجب أن يحدث في كل flow: عدد queries، والـ Cookies التي ترجع، وعدم استمرار العمل بعد deadline. هذه tests تكشف تغيّر السلوك مباشرة، وتساعد المراقبة على إظهار الأعمال العالقة التي لا تنتهي أصلًا.

### Tests قليلة الكلفة وحتمية النتائج

1. **Query budget لكل flow.** إدراج statement counter من `scratchpad/credentials/counter.ts` في integration harness. يعدّل هذا counter الدوال `BunSQLPreparedQuery.execute/all` و`BunSQLSession.transaction`. تُثبَّت counts المتوقعة لكل flow:
   - cached dashboard GET: ‏0 auth queries.
   - write: ‏1.
   - upload: ‏≤ 2.
   - password sign-in، و`verify-totp`، وOTP send وverify.
   - التحقق من عدم تشغيل أي statement من نوع `delete from "verifications" where "expires_at"` على request path.

   كان هذا test وحده سيكشف P-3 وP-6 وP-12 وP-13، وكذلك dropped-cookie bug الأصلي الذي ظهر في صورة request يستخدم DB path كل مرة.

2. **Cookie matrix: route × session-state.** نقل `scratchpad/cookies/route-cookies.probe.test.ts` إلى `tests/integration`. لكل route class، تُغطَّى حالات no cache، وrow تجاوز `updateAge`، وrow محذوف مع valid cache. يُتحقق من `Set-Cookie` headers التي ترجع، ومن ضبط `Cache-Control: no-store`. تُنفَّذ الحالات عبر `app.handle` عند success وvalidation-error وauthorization-refusal، مع Cookie names ذات البادئة `__Secure-` باستخدام HTTPS base URL، وتضمين chunk cleanup لـ `session_data.N` كما في PA2. يكشف ذلك C-1 وC-2 وC-3 وأي route جديد يتجاوز `withQueuedCookies`.
3. **Junk-cookie case** في `permission-database-path.test.ts` لاكتشاف C-5.
4. **WAL frames لكل admission** يجب أن تكون ≤ 1.3. نقل `scratchpad/infra/frames.ts` إلى tests الدائمة، وفق P-1b.
5. **حد لعدد prepared statements:** إرسال N filter shapes مختلفة باستخدام pool مضبوط على `max: 1`، ثم التحقق من أن `pg_prepared_statements` يظل ضمن حد ثابت بعد إضافة `maxLifetime`، وفق P-2.
6. **Timing floor:** عند verify success، يجب أن ترجع response في أقل من FLOOR/2، وفق P-14.
7. **Private delete:** لا يوجد call إلى `purgeUrls`، وفق P-15. وإذا اعتُمد مقترح C-6، يجب أن يعطي signing للمفتاح الخاص نفسه مرتين خلال window واحدة URL نفسه.
8. **Media budget:** تُعالَج SVG بحجم يصل إلى cap في أقل من N ms، وتنفّذ `optimizeImage` على WebP بدقة 2048 px وجودة q95 عددًا لا يتجاوز 3 encodes، وفق P-4 وP-5.
9. **Browser-jar revocation test (PA2):** إبطال row، ثم طلب session-only route والحصول على 401، ثم تطبيق كل Cookies المعادة، ثم استدعاء permission route و`get-session`. يُتحقق من أن session أصبحت غائبة بشكل متسق، وفق C-2.
10. **Cache-input matrix (PA2):** token only، وvalid cache، وmalformed value، وmalformed chunk ‏(`session_data.0`)، وexpired cache، وinactive user، وinactive role. يُتحقق معًا من status، وauthorization source المستخدم، وcookie jar الناتج، وفق C-5.
11. **Outbound deadlines:** اختبار OAuth token exchange مع provider لا يرسل headers أبدًا، وآخر يرسل body ببطء وعلى دفعات. يُتحقق من حدوث abort فعلي ومن elapsed bound، وفق P-19.
12. **Total budgets باستخدام fake clock:** اختبار `purgeUrls` مع 31 URLs وslow retries، واختبار maintenance pass مع R2 لا يستجيب. يُتحقق من elapsed bound، وعدم بدء أي attempt بعد deadline، والحفاظ على markers، وبقاء ordinary pool capacity متاحة، وفق P-26 وP-27.
13. **Sweep مع row مقفول:** إبقاء overdue row مقفولًا خلال sweep، والتحقق من استمرار الإبلاغ عن backlog، ثم فك القفل وإعادة التشغيل، وفق P-28.
14. **Harness self-tests:** يجب أن يُفشِل stranded after-response work التشغيل، وفق T-1؛ ويجب أن يستخدم retention failure test الـ scheduled callback الحقيقي، وفق T-2.
15. **JWKS fetch count:** يجب أن تُنتج N verifications تستخدم shared resolver عملية fetch واحدة، وفق P-19.

تُفضَّل deterministic contract tests هذه على full-server speed thresholds. تُضاف timing gates فقط بعد توفر stable baseline داخل Linux container.

### Monitoring دون إضافة dependency جديدة

1. **Event-loop lag sampler.** استخدام `setInterval(…, 500)` لقياس drift، وتسجيل structured warning عندما يتجاوز 50 ms، وإظهار p99 وmax في health endpoint. لا يقيس التطبيق ذلك حاليًا؛ وكان سيكشف P-1 وP-5 وKnown #13.
2. **`Server-Timing` في dev.** إضافة `rl;dur=` للـ limiter، و`auth;dur=` للـ session وgrants، و`db;desc=<count>` و`tx;desc=<count>` لكل request، بحيث يظهر query-count regression في DevTools.
3. **Cache-hit ratio للـ cookie cache.** عدّ requests التي حملت `session_data` وأُجيب عنها دون session query، ومقارنتها بما وصل إلى database، وتسجيل النسبة كل 15 دقيقة. نسبة قريبة من 0 هي بالضبط علامة dropped-cookie bug.
4. **PostgreSQL gauges** خلال periodic sweep:
   - ‏`count(*) from pg_prepared_statements` لكل PostgreSQL backend، وفق P-2.
   - أطول مدة `idle in transaction` من `pg_stat_activity`، وفق AUTH-6.
   - pool wait time، وفق P-20.
5. **Per-call fields:**
   - ‏`iterations` و`ms` لكل `optimizeImage`، وفق P-4.
   - عدد purge calls مقارنة بعدد URLs التي نُفِّذ لها purge لكل sweep، وفق P-21.
   - event مستقل باسم `otp.budget.exhausted`.
6. **Startup:** تسجيل boot duration وRSS بعد `listen`، وفق P-11 وP-5b.
7. **Background work (PA2):** count وage للـ pending after-response work، وعمر أقدم transition أو orphan marker، ووقت بدء maintenance job وعمره؛ فالـ log الذي لا يظهر إلا عند completion لا يصف job لا يزال عالقًا. وإضافة overdue-row sample قليلة التكرار، لا تعتمد على علم `hasMore` الخاص بالـ job نفسه، وفق P-27 وP-28.
8. **Outbound providers:** duration وin-flight count وaborts وretries لكل provider، إضافة إلى JWKS fetches لكل OAuth verification، وفق P-19 وP-26.
9. **Test feedback:** test duration لكل ملف، وcleanup time، وعدد failed drains، وفق T-1.

تُصدر هذه المقاييس كـ bounded aggregates مرة كل دقيقة، عبر structured logger الموجود، مع تسمية routes وفق template. لا تُسجَّل Cookies أو tokens أو OTP destinations أو SQL parameters أو URL lists أبدًا. يُطلق alert عندما يتجاوز provider call الـ deadline المعلن، أو يفشل drain، أو يبقى job يعمل بعد pass budget.

---

## 8. أمور لم يُتحقَّق منها

- جميع timings على Linux VPS. يعتمد حجم أثر P-1 على disk؛ يجب إعادة تشغيل `scratchpad/infra/bench-variants.ts` هناك.
- ما إذا كان front-end يدخل في loop أو يتصرف بصورة خاطئة خلال window المذكورة في C-2، أو مع stale name في C-3.
- ما إذا كان R2 يحترم `response-cache-control` على signed URLs، وفق C-6، وما إذا كان يعيد ETag عند COPY، وفق P-17.
- ما إذا كان `node:https` agent في Bun يعيد استخدام S3 connections فعليًا.
- ما إذا كان `bun:sql` يستخدم pipelining لإرسال `set_config` مع statement التالية على reserved connection، وفق P-17 و`cutAt`.
- default fetch timeout في Bun؛ أثبت P-19 فقط أنه أطول من 15 s. وكذلك latency الفعلي لـ SMTP وGoogle.
- تهيئة `ctx.context.session` من policy hook لتخطي third session read في المكتبة، وفق P-12.
- ‏`bun build --compile`؛ جُرِّب plain bundle فقط.

---

## ملحق: scratch scripts

كل الملفات موجودة تحت ‏`%TEMP%\claude\D--apps-job-app-soft-house-dash-4-apps-back-end\1ac11d4f-5dfa-461e-9713-1b99971880d7\scratchpad\`. هذا المسار temporary وsession-scoped؛ ينبغي نسخ أي ملفات مطلوبة للاحتفاظ بها إلى مكان دائم.

| المجلد         | Scripts                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline/`    | `env.sh`, `boot.ts`, `mods.ts`, `rss.ts`, `buildopenapi-time.ts`, `bench*.ts`, `parts.ts`, `hdrs.ts`, `wire.ts`, `early.ts`, `headers-probe.ts`, `logcost.ts`, `bootbundle.ts`          |
| `session/`     | `run-probe.ts`, `probe.test.ts`, `probe2.test.ts`, `probe3.test.ts` (junk cookie), `bench*.test.ts`, `agg.ts`, `prof-*.txt`                                                             |
| `credentials/` | `runner.ts`, `counter.ts`, `signin-count.test.ts`, `otp-and-lock.test.ts`, `cache-after-2fa.test.ts`, `live-path.test.ts`, `adapter-cost.test.ts`, `argon-bench.ts`, `fetch-timeout.ts` |
| `media/`       | `bench-image.ts`, `bench-rungs.ts`, `bench-realistic.ts`, `bench-svg.ts`, `bench-jsdom.ts`, `bench-svgo-pass.ts`, `bench-presign.ts`, `bench-sha.ts`, `bench-multipart2.ts`             |
| `db/`          | `mkdb.ts`, `seed.sql`, `dropdb.ts`, `explain-*.ts`, `bench-drizzle-ctor.ts`, `bench-tx.ts`, `bench-audit.ts`, `prepared-*.ts`, `pool-wait.ts`                                           |
| `infra/`       | `bench-limiter.ts`, `bench-variants.ts`, `frames.ts`, `sweep-noindex.ts`, `bench-sweep.ts`, `bench-ip.ts`                                                                               |
| `cookies/`     | `run-probe.ts`, `route-cookies.probe.test.ts`, `self-rename.probe.test.ts`, `headers-merge.ts`, `probe-output.txt`                                                                      |

أُنشئت probe database لكل run، ثم حُذفت بعده. حذف database auditor القاعدة `perfaudit_db_scratch`.

**أدلة التدقيق الثاني** موجودة في ‏`C:/Users/Administrator/AppData/Local/Temp/performance-audit-2-scratchpad/`:

| المجلد              | Scripts                                       |
| ------------------- | --------------------------------------------- |
| `auth-cookies/`     | `proofs-preload.ts`, `extended-preload.ts`    |
| `data-maintenance/` | `retention-locked.ts`                         |
| `media-resources/`  | `purge-deadline.ts`, `image-ladder.ts`        |
| `root/`             | `drain-benchmark.ts`, `stranded-work.test.ts` |

تُشغَّل auth proofs الخاصة بالتدقيق الثاني كـ extra preload عبر guarded integration runner، انطلاقًا من `apps/back-end`:

```powershell
bun tests/helpers/run.ts integration session-cookie-delivery --preload=C:/Users/Administrator/AppData/Local/Temp/performance-audit-2-scratchpad/auth-cookies/extended-preload.ts "--test-name-pattern=cache cookie alone"
```

شغّل التدقيق الثاني أيضًا 755 tests موجودة: HTTP/runtime، و`session-cookie-delivery`، وmedia validation وpurge، وSQLite وlimiter، وpermission scope. نجحت كلها. لم يكن ذلك full-suite run.

</div>
