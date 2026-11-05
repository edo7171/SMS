# דשבורד SMS — דומינו׳ס

דשבורד סטטי (HTML + JavaScript) שמתארח ב־GitHub Pages ושומר את הנתונים ב־Firestore של הפרויקט `infousms-abdc7`.

## קבצים
- `index.html` — מסך הכניסה, העיצוב והחיבור ל־Firebase.
- `app.js` — המסכים, המדדים, ההשוואות והמסקנות האוטומטיות.
- `sms-core.js` — סיווג ההודעות וסיכום יומי (ישמש גם לייבוא האוטומטי מהמייל).
- `firestore.rules` — כללי אבטחה: רק מיילים שברשימה יכולים לקרוא ולכתוב.
- `.nojekyll` — מונע מ־GitHub Pages לעבד את הקבצים.
- `.gitignore` — מונע העלאה של קבצי CSV/Excel עם נתוני לקוחות.

## הקמה
### 1. Firebase Console
- Firestore Database: יצירת מסד (Production mode).
- Rules: להדביק את התוכן של `firestore.rules` אחרי שמוסיפים את כתובות המייל המורשות, וללחוץ Publish.
- Authentication > Sign-in method: להפעיל Google.
- Authentication > Settings > Authorized domains: להוסיף `<שם-המשתמש>.github.io`.
- אם מפעילים גם Email/Password: Authentication > Settings > User actions — לבטל את "Enable create (sign-up)" ולהוסיף משתמשים ידנית.

### 2. GitHub
- להעלות את כל הקבצים בתיקייה הזו לשורש של repository.
- Settings > Pages > Source: Deploy from a branch, ענף `main`, תיקייה `/ (root)`.
- הדשבורד יהיה זמין בכתובת `https://<שם-המשתמש>.github.io/<שם-ה-repo>/`.

### 3. הגבלת מפתח ה־API (מומלץ)
ב־Google Cloud Console > APIs & Services > Credentials, לפתוח את המפתח של הפרויקט ולהגביל אותו ל־HTTP referrers:
`https://<שם-המשתמש>.github.io/*`, `http://localhost:*/*` ו־`https://infousms-abdc7.firebaseapp.com/*`.
GitHub עשוי לשלוח התראת "secret detected" על המפתח — זה צפוי. מפתח Firebase לאפליקציית דפדפן הוא מזהה ציבורי; ההגנה על הנתונים היא כללי האבטחה.

## טעינת הנתונים הראשונית
בלשונית "ייבוא והגדרות":
1. ייבוא דוח SMS — שלושת קבצי ה־CSV.
2. ייבוא נתוני מענה — קובץ 2025 ואחריו קובץ 2026.
3. "טעינת המסקנות".
4. עלות — 0.005 ₪ למקטע.

הקבצים נקראים בדפדפן ולא עולים ל־GitHub. מספרי טלפון נשמרים ב־Firestore רק כמזהה מוצפן; נוסח ההודעות ושמות הלקוחות לא נשמרים.

## בדיקה מקומית
`npx serve .` ואז http://localhost:3000. פתיחה ישירה של הקובץ (file://) לא תעבוד, כי הקוד נטען כמודולים.

## מבנה הנתונים ב־Firestore
- `days/{stream}_{date}` — סיכום יומי.
- `freq/{stream}_{date}_{n}` — מזהי לקוחות מוצפנים של אותו יום, לחישוב תדירות.
- `responses/{from}_{to}` — נתוני מענה לפי סניף.
- `insights`, `dailyInsights`, `settings/main`, `imports`.

ייבוא חוזר של יום מחליף אותו.

## השלב הבא: ייבוא אוטומטי מהמייל
אפשרות שמתאימה ל־GitHub: GitHub Action מתוזמן (cron) שקורא את הדוח היומי מתיבת המייל, מריץ את `DayAggregator` מ־`sms-core.js` ב־Node, וכותב ל־Firestore עם Service Account ששמור ב־GitHub Secrets.
