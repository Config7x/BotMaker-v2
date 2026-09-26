<?php
require_once __DIR__ . '/_init.php';
rx_cron_boot('atlaspaycheck', 60);

ini_set('error_log', 'error_log');

$ctx = rx_cron_load_payment_context();
if (empty($ctx['db_ready'])) {
    return;
}
require_once __DIR__ . '/../lib/PaymentConfirm.php';

global $pdo, $ManagePanel, $setting;
$ManagePanel = $ctx['managePanel'];
$setting = $ctx['setting'];

if (!($pdo instanceof PDO)) {
    error_log('[atlaspaycheck] no PDO connection');
    return;
}

if (!function_exists('atlaspayCheckOrder')) {
    error_log('[atlaspaycheck] atlaspay functions not available');
    return;
}

try {
    $stmt = $pdo->prepare(
        "SELECT id_order, atlaspay_order_id, price
           FROM Payment_report
          WHERE payment_Status = 'Unpaid'
            AND Payment_Method = 'atlaspay'
            AND atlaspay_order_id IS NOT NULL
            AND atlaspay_order_id <> ''
          ORDER BY id DESC
          LIMIT 30"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
} catch (Throwable $e) {
    error_log('[atlaspaycheck] select pending failed: ' . $e->getMessage());
    return;
}

if (empty($rows)) {
    return;
}

$successStatuses = ['confirmed', 'settled'];
$deadStatuses = ['rejected', 'expired', 'cancelled'];

foreach ($rows as $row) {
    if (function_exists('rx_cron_time_up') && rx_cron_time_up()) break;

    $orderId = (string) $row['id_order'];
    $atlaspayOrderId = trim((string) $row['atlaspay_order_id']);
    if ($atlaspayOrderId === '') {
        continue;
    }

    $check = atlaspayCheckOrder($atlaspayOrderId);
    if (!is_array($check) || (int) ($check['id'] ?? 0) !== (int) $atlaspayOrderId) {
        continue;
    }

    $status = (string) ($check['status'] ?? '');

    if (in_array($status, $deadStatuses, true)) {
        if ($status === 'expired' || $status === 'cancelled') {
            payment_mark_expired($orderId);
        } else {
            payment_notify_user_failed($orderId, 'پرداخت توسط اطلس‌پی رد شد');
        }
        continue;
    }

    if (!in_array($status, $successStatuses, true)) {
        continue;
    }

    if (!empty($check['requiresManualDelivery'])) {
        $channelReport = is_array($setting) ? (string) ($setting['Channel_Report'] ?? '') : '';
        if ($channelReport !== '' && function_exists('telegram')) {
            $actualReceived = isset($check['actualReceivedAmountToman']) ? (int) $check['actualReceivedAmountToman'] : null;
            $text = "⚠️ سفارش اطلس‌پی با کسری واریز تایید شد — نیاز به بررسی دستی.\n"
                . "🛒 کد فاکتور: <code>" . htmlspecialchars($orderId) . "</code>\n"
                . "💰 مبلغ سفارش: " . number_format((int) $row['price']) . " تومان\n"
                . ($actualReceived !== null ? ('💸 مبلغ واریزی واقعی: ' . number_format($actualReceived) . ' تومان') : '');
            telegram('sendmessage', [
                'chat_id'    => $channelReport,
                'message_thread_id' => $ctx['paymentreports'] ?? null,
                'text'       => $text,
                'parse_mode' => 'HTML',
            ]);
        }
        continue;
    }

    $actualReceived = isset($check['actualReceivedAmountToman']) ? (int) $check['actualReceivedAmountToman'] : null;
    $extra = [
        'method'      => 'atlaspay',
        'thread_id'   => $ctx['paymentreports'] ?? null,
        'extra_lines' => array_filter([
            $actualReceived !== null ? ('💸 مبلغ نهایی تأییدشده توسط اطلس‌پی : ' . number_format($actualReceived) . ' تومان') : '',
            '🔁 تایید از طریق پولر',
        ]),
    ];

    payment_confirm_paid($orderId, 'chashbackatlaspay', $extra);
}
