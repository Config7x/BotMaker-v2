<?php


declare(strict_types=1);

require_once __DIR__ . '/BaseHandler.php';
require_once __DIR__ . '/DiscountSupport.php';

final class CryptoCancelInvoiceHandler extends BaseHandler
{
    public function handle(): void
    {
        $this->requireMethod('POST');

        $orderId = {{BRAND_NAME}}Input::string($this->data, 'order_id');
        if ($orderId === '') {
            {{BRAND_NAME}}Response::badRequest('order_id is required');
        }

        $report = {{BRAND_NAME}}Db::fetchOne(
            'SELECT id_order, payment_Status, Payment_Method, atlaspay_order_id FROM Payment_report
              WHERE id_order = :o AND id_user = :u AND source = \'miniapp\' LIMIT 1',
            [':o' => $orderId, ':u' => (string)$this->user['id']]
        );
        if ($report === null) {
            {{BRAND_NAME}}Response::notFound('Payment not found');
        }
        $method = trim((string)($report['Payment_Method'] ?? ''));
        $cancellable = ['arze digital offline', 'plisio', 'nowpayment', 'digitaltron', 'cart to cart', 'carttocart_pv', 'iranpay2', 'tonpay', 'cubepay', 'blupal', 'variza', 'abangateway', 'atlaspay'];
        if (!in_array($method, $cancellable, true)) {
            {{BRAND_NAME}}Response::fail(422, 'این فاکتور قابل لغو از این طریق نیست');
        }
        $status = (string)($report['payment_Status'] ?? '');


        if (in_array($status, ['cancelled', 'paid', 'reject'], true)) {
            {{BRAND_NAME}}Response::ok([
                'kind'    => 'already_finalized',
                'message' => 'این فاکتور قبلاً نهایی شده است',
                'status'  => $status,
            ]);
            return;
        }

        if (!in_array($status, ['Unpaid', 'AwaitingHash', 'expire'], true)) {
            {{BRAND_NAME}}Response::fail(409, 'این فاکتور در وضعیتی نیست که قابل لغو باشد (' . $status . ')');
        }

        MiniDiscount::releaseLastUnpaidDiscount((string)$this->user['id']);

        if ($method === 'atlaspay' && function_exists('atlaspayCancelOrder')) {
            $atlaspayOrderId = trim((string)($report['atlaspay_order_id'] ?? ''));
            if ($atlaspayOrderId !== '') {
                try {
                    atlaspayCancelOrder($atlaspayOrderId);
                } catch (Throwable $e) {
                    {{BRAND_NAME}}Logger::exception($e, 'AtlasPay cancel-order call failed', [
                        'user'  => $this->user['id'],
                        'order' => $orderId,
                    ]);
                }
            }
        }

        try {
            $pdo = {{BRAND_NAME}}Db::pdo();
            $stmt = $pdo->prepare(
                "UPDATE Payment_report
                    SET payment_Status = 'cancelled'
                  WHERE id_order = :o
                    AND id_user = :u
                    AND source = 'miniapp'
                    AND payment_Status IN ('Unpaid', 'AwaitingHash', 'expire')"
            );
            $stmt->bindValue(':o', $orderId, PDO::PARAM_STR);
            $stmt->bindValue(':u', (string)$this->user['id'], PDO::PARAM_STR);
            $stmt->execute();
        } catch (Throwable $e) {
            {{BRAND_NAME}}Logger::exception($e, 'Crypto cancel-invoice update failed', [
                'user'  => $this->user['id'],
                'order' => $orderId,
            ]);
            {{BRAND_NAME}}Response::serverError('خطا در لغو فاکتور');
        }

        {{BRAND_NAME}}Logger::debug('Crypto invoice cancelled by user', [
            'user'  => $this->user['id'],
            'order' => $orderId,
        ]);

        {{BRAND_NAME}}Response::ok([
            'kind'    => 'cancelled',
            'message' => '✅ فاکتور لغو شد',
        ]);
    }
}
