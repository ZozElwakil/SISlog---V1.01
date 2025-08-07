const TelegramBot = require('node-telegram-bot-api');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { URLSearchParams } = require('url');
const fs = require('fs').promises;
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- الإعدادات ---
const TELEGRAM_TOKEN = '7416283687:AAFwrECg6BwOilg5_PVo1Kh5Qs4DFd0jyvk';
const GEMINI_API_KEY = "AIzaSyD-1BPga7SHFF3mvYoGoTzsLbs6doomZgY";
const DB_PATH = './database.json';
const CHECK_INTERVAL = 60 * 60 * 1000;
const ENCRYPTION_KEY = 'ThisIsMyPersonalProjectSecret!@1';

// --- التهيئة ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const BASE_URL = "https://sis.eelu.edu.eg";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const userState = {};

// --- دوال التشفير وقاعدة البيانات ---
const algorithm = 'aes-256-cbc';
function encrypt(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(algorithm, Buffer.from(ENCRYPTION_KEY), iv); let encrypted = cipher.update(text); encrypted = Buffer.concat([encrypted, cipher.final()]); return { iv: iv.toString('hex'), encryptedData: encrypted.toString('hex') }; }
function decrypt(text) { if (!text || !text.iv || !text.encryptedData) { throw new Error("Invalid encrypted object format."); } const ivBuffer = Buffer.from(text.iv, 'hex'); const encryptedText = Buffer.from(text.encryptedData, 'hex'); const decipher = crypto.createDecipheriv(algorithm, Buffer.from(ENCRYPTION_KEY), ivBuffer); let decrypted = decipher.update(encryptedText); decrypted = Buffer.concat([decrypted, decipher.final()]); return decrypted.toString(); }
async function writeDB(data) { await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8'); }
async function readDB() { try { const data = await fs.readFile(DB_PATH, 'utf8'); if (data.trim() === '') return { users: {} }; return JSON.parse(data); } catch (error) { if (error.code === 'ENOENT') { const defaultData = { users: {} }; await writeDB(defaultData); return defaultData; } console.error("Error reading DB:", error); throw error; } }
async function saveUser(chatId, userData) { const db = await readDB(); db.users[chatId] = userData; await writeDB(db); }
async function getUser(chatId) { const db = await readDB(); return db.users[chatId] || null; }

// --- الأزرار ---
const mainKeyboard = { reply_markup: { keyboard: [[{ text: '📊 عرض أحدث نتيجة' }, { text: '✍️ التسجيل الأكاديمي' }], [{ text: '🤖 تحليل ونصيحة' }, { text: '🔄 تحديث البيانات' }]], resize_keyboard: true } };
const registrationKeyboard = { reply_markup: { keyboard: [[{ text: '📚 عرض المواد المتاحة' }], [{ text: '📝 تسجيل مواد (قريبًا)' }], [{ text: '🔙 العودة للقائمة الرئيسية' }]], resize_keyboard: true, one_time_keyboard: true } };
const analysisKeyboard = { reply_markup: { keyboard: [[{ text: 'تحليل عام للنتائج' }], [{ text: 'إلغاء الأمر' }]], resize_keyboard: true, one_time_keyboard: true } };
const cancelKeyboard = { reply_markup: { keyboard: [[{ text: 'إلغاء الأمر' }]], resize_keyboard: true, one_time_keyboard: true } };

// --- دوال جلب البيانات (مع التعديل) ---
async function fetchRegistrationData(sessionCookie) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const regBody = new URLSearchParams({ param0: 'AcdRegistration.academicRegistration', param1: 'studentsCourses', param2: JSON.stringify({}) });
    const response = await fetch(`${BASE_URL}/getJCI`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": sessionCookie, "User-Agent": USER_AGENT }, body: regBody });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    const data = await response.json();
    
    // *** التعامل الذكي مع الردود ***
    if (data.MSG !== 'success') {
        if (data.MSG && data.MSG.includes('لم يتم تحديد ميعاد بداية التسجيل')) {
            return { registrationNotOpen: true, message: "فترة التسجيل مغلقة حاليًا." };
        }
        throw new Error(data.MSG || "خطأ في جلب بيانات التسجيل.");
    }
    return data;
}

// --- دالة التحليل ---
async function getGeminiAnalysis(studentData, registrationData, userQuestion) {
    const transcriptText = studentData.StuSemesterData.map(year => `\nالعام الدراسي: ${year.AcadYearName.split('|')[0]}\n` + year.Semesters.map(semester => (semester.Courses && semester.Courses.length > 0) ? `  الفصل: ${semester.SemesterName.split('|')[0]}\n` + semester.Courses.map(course => `    - ${course.CourseName.split('|')[0]}: ${course.Grade}\n`).join('') : '').join('')).join('');
    const academicInfo = registrationData && !registrationData.registrationNotOpen ? `\nبيانات أكاديمية: المعدل: ${registrationData.StudentData.StuGPA}, الساعات المكتسبة: ${registrationData.StudentData.studentEarnedHrs}, الساعات المسموح بها: ${registrationData.StudentData.loadHours}` : '';
    const prompt = `أنت مستشار أكاديمي خبير. حلل بيانات الطالب التالية وأجب على سؤاله بنبرة إيجابية وقدم نصائح عملية. لا تستخدم Markdown معقد.\n\nبيان الدرجات:\n${transcriptText}\n${academicInfo}\n\nسؤال الطالب: "${userQuestion}"\n\nالتحليل والنصائح:`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

// (باقي الدوال المساعدة تبقى كما هي)
function escapeMarkdown(text) { if (typeof text !== 'string') return text; const toEscape = /[_*[\]()~`>#+\-=|{}.!]/g; return text.replace(toEscape, '\\$&'); }
function getCookieExpiry(cookies) { const userCookie = cookies.find(c => c.startsWith('userID=')); if (!userCookie) return null; const parts = userCookie.split('|'); if (parts.length > 3 && parts[2].startsWith('10:')) { const timestamp = parseInt(parts[2].substring(3), 10); return new Date(timestamp * 1000); } return null; }
async function performLogin(username, password) { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; const formData = new URLSearchParams({ UserName: username, Password: password, sysID: '313.', UserLang: 'E', userType: '2' }); const loginResponse = await fetch(`${BASE_URL}/studentLogin`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": USER_AGENT }, body: formData }); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'; const cookies = loginResponse.headers.raw()['set-cookie']; if (!cookies || cookies.length === 0) throw new Error("فشل تسجيل الدخول. تأكد من صحة البيانات."); const loginResult = await loginResponse.json(); if (!(loginResult.rows && loginResult.rows[0].row.LoginOK === "True")) { const errorMsg = (loginResult.rows[0].row.messageError || "Login failed").split('|')[0]; throw new Error(errorMsg); } const cookieString = cookies.map(c => c.split(';')[0]).join('; '); const cookieExpiry = getCookieExpiry(cookies); return { sessionCookie: cookieString, cookieExpires: cookieExpiry }; }
async function fetchTranscript(sessionCookie) { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; const transcriptBody = new URLSearchParams({ param0: 'Reports.RegisterCert', param1: 'getTranscript', param2: JSON.stringify({ "ShowDetails": "true", "portalFlag": "true", "RegType": "student" }) }); const transcriptResponse = await fetch(`${BASE_URL}/getJCI`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": sessionCookie, "User-Agent": USER_AGENT }, body: transcriptBody }); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'; const data = await transcriptResponse.json(); if (data.MSG !== 'success') throw new Error("خطأ في جلب الدرجات. قد تكون الجلسة قد انتهت."); return data; }
async function getSmartTranscript(chatId) { let user = await getUser(chatId); if (!user) throw new Error("المستخدم غير مسجل."); if (user.sessionCookie && user.cookieExpires && new Date(user.cookieExpires) > new Date()) { try { console.log(`[${chatId}] Using cached cookie.`); return await fetchTranscript(user.sessionCookie); } catch (e) { console.log(`[${chatId}] Cached cookie failed. Re-login.`); } } console.log(`[${chatId}] Cookie expired. Performing new login.`); const password = decrypt(user.encryptedPassword); const { sessionCookie, cookieExpires } = await performLogin(user.username, password); const transcript = await fetchTranscript(sessionCookie); user.sessionCookie = sessionCookie; user.cookieExpires = cookieExpires ? cookieExpires.toISOString() : null; user.lastTranscript = transcript; await saveUser(chatId, user); return transcript; }
function showTranscript(chatId, data) { const studentName = escapeMarkdown(data.stuName.split('|')[1]?.trim() || data.stuName.split('|')[0]); const studentLevel = escapeMarkdown(data.level.split('|')[1]?.trim() || data.level.split('|')[0]); let resultMessage = `✅ *تم جلب النتائج بنجاح\\!*\n\n`; resultMessage += `👤 *الطالب:* ${studentName}\n`; resultMessage += `🎓 *المستوى:* ${studentLevel}\n`; try { const levelsResults = JSON.parse(data.levelsResults.replace(/'/g, '"')); const lastLevelKey = Object.keys(levelsResults).pop(); if(lastLevelKey && levelsResults[lastLevelKey].AccumGPA) { const gpa = escapeMarkdown(levelsResults[lastLevelKey].AccumGPA); resultMessage += `⭐ *المعدل التراكمي:* ${gpa}\n`; } } catch(e) {} resultMessage += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`; data.StuSemesterData.forEach(year => { if (year.Semesters?.some(s => s.Courses?.length > 0)) { const yearName = escapeMarkdown(year.AcadYearName.split('|')[0]); resultMessage += `\n🗓️ *${yearName}*\n`; year.Semesters.forEach(semester => { if (semester.Courses && semester.Courses.length > 0) { const semesterName = escapeMarkdown(semester.SemesterName.split('|')[0]); resultMessage += `  \\- _${semesterName}_\n`; semester.Courses.forEach(course => { const courseName = escapeMarkdown(course.CourseName.split('|')[0]); const formattedGrade = formatGrade(course.Grade, course.failCheck); resultMessage += `    ${formattedGrade.emoji} ${courseName}: *${formattedGrade.text}*\n`; }); if (semester.GPA && semester.CurrGPA) { const gpa = escapeMarkdown(semester.GPA); const currGpa = escapeMarkdown(semester.CurrGPA); resultMessage += `  📈 _المعدل الفصلي: ${gpa} \\| التراكمي: ${currGpa}_\n`; } } }); } }); bot.sendMessage(chatId, resultMessage, { parse_mode: 'MarkdownV2' }); }
function formatGrade(grade, failCheck) { if (!grade || grade.trim() === "") return { text: "لم ترصد", emoji: "⚪️" }; const arabicPart = grade.split('|')[0].trim(); const g = arabicPart.toUpperCase(); if (failCheck === true && g !== 'PC') return { text: "راسب", emoji: "🔴" }; if (g === "غ" || g === "ABS") return { text: "غائب", emoji: "🔴" }; if (g === 'ر' || g === 'F') return { text: "راسب", emoji: "🔴" }; switch (g) { case 'أ+': case 'A+': return { text: "أ\\+", emoji: "🟢" }; case 'أ': case 'A': return { text: "أ", emoji: "🟢" }; case 'أ-': case 'A-': return { text: "أ\\-", emoji: "🟢" }; case 'ب+': case 'B+': return { text: "ب\\+", emoji: "🟢" }; case 'ب': case 'B': return { text: "ب", emoji: "🟢" }; case 'ب-': case 'B-': return { text: "ب\\-", emoji: "🟢" }; case 'ج+': case 'C+': return { text: "ج\\+", emoji: "🟡" }; case 'ج': case 'C': return { text: "ج", emoji: "🟡" }; case 'ج-': case 'C-': return { text: "ج\\-", emoji: "🟡" }; case 'د+': case 'D+': return { text: "د\\+", emoji: "🟡" }; case 'د': case 'D': return { text: "د", emoji: "🟡" }; case 'PC': return { text: "ناجح", emoji: "🟢" }; default: return { text: escapeMarkdown(arabicPart), emoji: "⚪️" }; } }

// --- معالج الرسائل الرئيسي ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text.startsWith('/')) return;

    // --- معالجة الحالات الخاصة ---
    if (userState[chatId]) {
        const state = userState[chatId].type;
        const user = await getUser(chatId);
        if (state === 'awaiting_analysis_question') {
            if (text === 'إلغاء الأمر') { delete userState[chatId]; bot.sendMessage(chatId, "تم الإلغاء.", mainKeyboard); return; }
            const question = (text === 'تحليل عام للنتائج') ? "حلل لي نتائجي بشكل عام وقدم لي نصائح." : text;
            const processingMessage = await bot.sendMessage(chatId, "رائع! أقوم الآن بإعداد التحليل...", mainKeyboard);
            delete userState[chatId];
            try {
                const regData = user.lastRegistrationData;
                const aiResponse = await getGeminiAnalysis(user.lastTranscript, regData, question);
                if (aiResponse && aiResponse.trim()) {
                    bot.editMessageText(aiResponse, { chat_id: chatId, message_id: processingMessage.message_id });
                } else {
                    bot.editMessageText("عذرًا، لم أتمكن من إنشاء تحليل.", { chat_id: chatId, message_id: processingMessage.message_id });
                }
            } catch (e) { console.error("Gemini analysis error:", e); bot.editMessageText("عفوا، حدث خطأ فني أثناء التحليل.", { chat_id: chatId, message_id: processingMessage.message_id }); }
            return;
        }
    }

    // --- الأوامر العادية ---
    const user = await getUser(chatId);
    if (user) {
        switch (text) {
            case '📊 عرض أحدث نتيجة': showTranscript(chatId, user.lastTranscript); return;
            case '✍️ التسجيل الأكاديمي': userState[chatId] = { type: 'registration_menu' }; bot.sendMessage(chatId, "أهلاً بك في قائمة التسجيل الأكاديمي.", registrationKeyboard); return;
            case '📚 عرض المواد المتاحة':
                const loadingMsg = await bot.sendMessage(chatId, "🔍 جاري جلب بيانات التسجيل...");
                try {
                    const regData = await fetchRegistrationData(user.sessionCookie);
                    if (regData.registrationNotOpen) {
                        bot.editMessageText(`⏳ ${regData.message} يرجى المحاولة في وقت لاحق.`, { chat_id: chatId, message_id: loadingMsg.message_id });
                        return;
                    }
                    user.lastRegistrationData = regData;
                    await saveUser(chatId, user);
                    let message = `*بيانات التسجيل:*\n*الساعات المكتسبة:* ${regData.StudentData.studentEarnedHrs}\n*الحد الأقصى للساعات:* ${regData.StudentData.loadHours}\n\n*المواد المتاحة:*\n\n`;
                    const availableCourses = regData.Courses.flatMap(level => Object.values(level)).flat();
                    if (availableCourses.length > 0) {
                        message += availableCourses.map(c => `\\- *${escapeMarkdown(c.GeneralCourseName.split('|')[0])}* (${escapeMarkdown(c.GeneralCourseCode.split('|')[0])}) \\- ${c.CrHr} ساعات`).join('\n');
                    } else {
                        message += "_لا توجد مواد متاحة حاليًا للتسجيل._";
                    }
                    bot.editMessageText(message, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'MarkdownV2' });
                } catch (error) { bot.editMessageText(`❌ فشل جلب البيانات: ${error.message}`, { chat_id: chatId, message_id: loadingMsg.message_id }); }
                return;
            case '📝 تسجيل مواد (قريبًا)': bot.sendMessage(chatId, "هذه الميزة لا تزال قيد التطوير وستتوفر قريبًا.", registrationKeyboard); return;
            case '🔙 العودة للقائمة الرئيسية': delete userState[chatId]; bot.sendMessage(chatId, "تم العودة للقائمة الرئيسية.", mainKeyboard); return;
            case '🤖 تحليل ونصيحة':
                if (!user.lastRegistrationData || user.lastRegistrationData.registrationNotOpen) {
                    await bot.sendMessage(chatId, "لتقديم أفضل تحليل، سأجلب بياناتك الأكاديمية أولاً...");
                    try {
                        const regData = await fetchRegistrationData(user.sessionCookie);
                        user.lastRegistrationData = regData; // سيحتوي إما على البيانات أو على علامة أن التسجيل مغلق
                        await saveUser(chatId, user);
                    } catch (e) { console.log("Could not fetch reg data for analysis."); }
                }
                userState[chatId] = { type: 'awaiting_analysis_question' };
                bot.sendMessage(chatId, "📝 *يمكنك الآن كتابة سؤال محدد*، أو اضغط على زر 'تحليل عام'.", analysisKeyboard);
                return;
            case '🔄 تحديث البيانات': const pMsg = await bot.sendMessage(chatId, "🔄 جاري تحديث بياناتك..."); try { const transcript = await getSmartTranscript(chatId); bot.deleteMessage(chatId, pMsg.message_id); bot.sendMessage(chatId, "✅ تم تحديث بياناتك بنجاح!"); showTranscript(chatId, transcript); } catch (error) { bot.editMessageText(`❌ فشل التحديث: ${error.message}`, { chat_id: chatId, message_id: pMsg.message_id }); } return;
        }
    }

    // --- منطق تسجيل الدخول ---
    const lines = text.split('\n');
    if (lines.length >= 2) {
        const [username, password] = [lines[0].trim(), lines[1].trim()];
        if (!username || !password) return;
        const processingMessage = await bot.sendMessage(chatId, `🔍 جاري التحقق من بياناتك وتسجيل الدخول...`);
        try {
            const { sessionCookie, cookieExpires } = await performLogin(username, password);
            const transcript = await fetchTranscript(sessionCookie);
            const userData = { username, encryptedPassword: encrypt(password), sessionCookie, cookieExpires: cookieExpires ? cookieExpires.toISOString() : null, lastTranscript: transcript, lastCheck: new Date().toISOString() };
            await saveUser(chatId, userData);
            bot.deleteMessage(chatId, processingMessage.message_id);
            const escapedName = escapeMarkdown(transcript.stuName.split('|')[1]?.trim());
            bot.sendMessage(chatId, `✅ تم تسجيل الدخول بنجاح\\! مرحباً بك، *${escapedName}*\\.`, { ...mainKeyboard, parse_mode: 'MarkdownV2' });
        } catch (error) { console.error(`Error for user ${username}:`, error.message); bot.deleteMessage(chatId, processingMessage.message_id); bot.sendMessage(chatId, `❌ حدث خطأ: ${error.message}.`); }
        return;
    }
    if (text !== '/start' && !user) { bot.sendMessage(chatId, "أهلاً بك! يرجى تسجيل الدخول أولاً بإرسال اسم المستخدم وكلمة المرور."); }
});

// --- الفحص الدوري ---
async function checkForUpdates() {
    console.log(`[${new Date().toLocaleString()}] Running scheduled check for updates...`);
    const db = await readDB();
    if (!db.users || Object.keys(db.users).length === 0) { console.log("No users in DB to check."); return; }
    for (const chatId in db.users) {
        try {
            const user = db.users[chatId];
            console.log(`Checking for: ${user.username}`);
            const newTranscript = await getSmartTranscript(chatId);
            const oldCourses = user.lastTranscript.StuSemesterData.flatMap(y => y.Semesters.flatMap(s => s.Courses));
            const newCourses = newTranscript.StuSemesterData.flatMap(y => y.Semesters.flatMap(s => s.Courses));
            const newGrades = [];
            newCourses.forEach(newCourse => { const oldCourse = oldCourses.find(c => c.CourseID === newCourse.CourseID); if (newCourse.Grade && (!oldCourse || !oldCourse.Grade)) { newGrades.push(newCourse); } });
            if (newGrades.length > 0) {
                console.log(`Found ${newGrades.length} new grades for ${user.username}`);
                let notificationMessage = "🎉 *إشعار بدرجات جديدة\\!*\\n\\nظهرت الدرجات التالية:\\n";
                newGrades.forEach(course => { const courseName = escapeMarkdown(course.CourseName.split('|')[0]); const formattedGrade = formatGrade(course.Grade, course.failCheck); notificationMessage += `  ${formattedGrade.emoji} ${courseName}: *${formattedGrade.text}*\n`; });
                bot.sendMessage(chatId, notificationMessage, { parse_mode: 'MarkdownV2' });
                const updatedUser = await getUser(chatId);
                updatedUser.lastTranscript = newTranscript;
                await saveUser(chatId, updatedUser);
            } else { console.log(`No new grades for ${user.username}`); }
        } catch (error) { console.error(`Failed to check updates for chatId ${chatId}:`, error.message); }
    }
}

// --- بدء التشغيل ---
bot.onText(/\/start/, (msg) => { bot.sendMessage(msg.chat.id, `أهلاً بك 👋\nأنا مساعدك الأكاديمي الذكي. يمكنني جلب نتائجك، تحليلها، وإعلامك بالجديد!\n\nللبدء، أرسل بياناتك كالتالي:\n*اسم المستخدم*\n*كلمة المرور*\n\nإذا كنت مسجلًا من قبل، ستظهر لك قائمة الأوامر بالأسفل.`, { ...mainKeyboard, parse_mode: 'Markdown' }); });
setInterval(checkForUpdates, CHECK_INTERVAL);
setTimeout(() => { console.log("Performing initial check on startup..."); checkForUpdates(); }, 5000);

console.log('🎉 البوت الأكاديمي الذكي (مع التعامل الذكي مع التسجيل) يعمل الآن...');