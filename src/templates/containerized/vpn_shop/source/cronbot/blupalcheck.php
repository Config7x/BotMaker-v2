<?php
require_once __DIR__ . '/_init.php';
rx_cron_boot('blupalcheck', 120);

ini_set('error_log', 'error_log');

$ctx = rx_cron_load_payment_context();
if (empty($ctx['db_ready'])) {
    return;
}
require_once __DIR__ . '/../lib/PaymentConfirm.php';

global $pdo, $ManagePanel;
$ManagePanel = $ctx['managePanel'];

if (!($pdo instanceof PDO)) {
    error_log('[blupalcheck] no PDO connection');
    return;
}

if (!function_exists('blupalCheckInvoice')) {
    error_log('[blupalcheck] blupal functions not available');
    return;
}

try {
    $stmt = $pdo->prepare(
        "SELECT id_order, blupal_invoice_id, price
           FROM Payment_report
          WHERE payment_Status = 'Unpaid'
            AND Payment_Method = 'blupal'
            AND blupal_invoice_id IS NOT NULL
            AND blupal_invoice_id <> ''
          ORDER BY id DESC
          LIMIT 30"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
} catch (Throwable $e) {
    error_log('[blupalcheck] select pending failed: ' . $e->getMessage());
    return;
}

if (empty($rows)) {
    return;
}

foreach ($rows as $row) {
    $orderId   = (string) $row['id_order'];
    $invoiceId = trim((string) $row['blupal_invoice_id']);
    if ($invoiceId === '') {
        continue;
    }

    $check = blupalCheckInvoice($invoiceId);
    if (!is_array($check) || (int) ($check['invoice_id'] ?? 0) !== (int) $invoiceId) {
        continue;
    }
    if (empty($check['success'])) {
        continue;
    }

    $blupalStatus = (string) ($check['status'] ?? '');
    if (in_array($blupalStatus, ['EXPIRED', 'CANCELED'], true)) {
        payment_mark_expired($orderId);
        continue;
    }
    if ($blupalStatus !== 'PAID') {
        continue;
    }

    $expectedRial = blupalTomanToRial($row['price']);
    $checkAmountRial = isset($check['amount']) ? (int) $check['amount'] : null;
    if ($checkAmountRial === null || $checkAmountRial !== $expectedRial) {
        error_log('[blupalcheck] amount mismatch on polled invoice, skipping: order=' . $orderId . ' invoice=' . $invoiceId);
        continue;
    }

    $finalAmountRial = isset($check['final_amount']) ? (float) $check['final_amount'] : null;
    if ($finalAmountRial === null) {
        continue;
    }

    $creditAmountToman = blupalRialToToman($finalAmountRial);
    $payerName = trim((string) ($check['payer_name'] ?? ''));
    $payerCard = trim((string) ($check['payer_card'] ?? ''));
    $payerBank = trim((string) ($check['payer_bank_name'] ?? ''));

    $extra = [
        'method'      => 'blupal',
        'thread_id'   => $ctx['paymentreports'] ?? null,
        'extra_lines' => array_filter([
            $creditAmountToman > 0 ? ('💸 مبلغ نهایی تأییدشده توسط بلوپال : ' . number_format($creditAmountToman) . ' تومان') : '',
            $payerName !== '' ? ('👤 نام واریزکننده : ' . $payerName) : '',
            $payerCard !== '' ? ('💳 شماره کارت/شبا واریزکننده : ' . $payerCard) : '',
            $payerBank !== '' ? ('🏦 بانک واریزکننده : ' . $payerBank) : '',
            '🔁 تایید از طریق پولر (وب‌هوک دیر یا گم‌شده)',
        ]),
    ];

    payment_confirm_paid($orderId, 'chashbackblupal', $extra);
}
