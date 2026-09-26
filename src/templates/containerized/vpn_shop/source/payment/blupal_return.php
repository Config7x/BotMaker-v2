<?php
ini_set('error_log', 'error_log');
require_once __DIR__ . '/../config.php';

$botUsername = isset($usernamebot) ? ltrim(trim((string) $usernamebot), '@') : '';
$botUrl = $botUsername !== '' ? ('https://t.me/' . $botUsername) : '#';
?>
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>بازگشت از بلوپال</title>
<style>
@font-face {
    font-family: 'Vazirmatn';
    src: url('/panel/fonts/Vazirmatn-Regular.woff2') format('woff2');
    font-weight: 400;
    font-display: swap;
}
@font-face {
    font-family: 'Vazirmatn';
    src: url('/panel/fonts/Vazirmatn-Medium.woff2') format('woff2');
    font-weight: 500;
    font-display: swap;
}
@font-face {
    font-family: 'Vazirmatn';
    src: url('/panel/fonts/Vazirmatn-Bold.woff2') format('woff2');
    font-weight: 700;
    font-display: swap;
}

:root {
    --bg: #1B1B1D;
    --card-bg: #242426;
    --border: #35353a;
    --text: #f2f2f4;
    --text-muted: #a3a3ab;
    --purple: #7c3aed;
    --purple-hover: #6d28d9;
    --success: #22c55e;
    --success-bg: rgba(34, 197, 94, 0.12);
}

* { box-sizing: border-box; }

html, body {
    height: 100%;
    margin: 0;
}

body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Vazirmatn', 'Tahoma', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.card {
    width: 100%;
    max-width: 420px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 32px 24px;
    text-align: center;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}

.icon-badge {
    width: 72px;
    height: 72px;
    margin: 0 auto 20px;
    border-radius: 50%;
    background: var(--success-bg);
    display: flex;
    align-items: center;
    justify-content: center;
}

.icon-badge svg {
    width: 36px;
    height: 36px;
    stroke: var(--success);
}

h1 {
    font-size: 19px;
    font-weight: 700;
    margin: 0 0 10px;
    color: var(--success);
}

p {
    font-size: 14px;
    line-height: 1.9;
    color: var(--text-muted);
    margin: 0 0 26px;
}

.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 14px 18px;
    background: var(--purple);
    color: #fff;
    text-decoration: none;
    font-family: inherit;
    font-size: 15px;
    font-weight: 500;
    border-radius: 12px;
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
}

.btn:hover, .btn:focus {
    background: var(--purple-hover);
}

.hint {
    margin-top: 18px;
    font-size: 12px;
    color: var(--text-muted);
}
</style>
</head>
<body>
    <div class="card">
        <div class="icon-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        <h1>پرداخت شما با موفقیت انجام شد</h1>
        <p>
            پرداخت شما توسط بلوپال تأیید شد. موجودی کیف‌پول یا سفارش شما
            به‌صورت خودکار به‌روزرسانی شده و از طریق ربات به شما اطلاع داده
            خواهد شد.
        </p>
        <a class="btn" href="<?php echo htmlspecialchars($botUrl, ENT_QUOTES, 'UTF-8'); ?>">بازگشت به ربات</a>
        <div class="hint">می‌توانید وضعیت دقیق سفارش را از داخل ربات یا مینی‌اپ پیگیری کنید.</div>
    </div>
</body>
</html>
