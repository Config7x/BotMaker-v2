<?php

final class {{BRAND_NAME}}WebhookAuth
{
    public static function secret(string $botToken, bool $useOverride = true): string
    {
        if ($useOverride) {
            $configured = getenv('TELEGRAM_WEBHOOK_SECRET') ?: ($_ENV['TELEGRAM_WEBHOOK_SECRET'] ?? '');
            if ($configured === '' && defined('TELEGRAM_WEBHOOK_SECRET')) {
                $configured = TELEGRAM_WEBHOOK_SECRET;
            }
            if (is_string($configured) && $configured !== '') return $configured;
        }
        return $botToken === '' ? '' : hash('sha256', $botToken . '_{{BRAND_NAME}}_webhook_secret');
    }

    public static function valid(string $botToken, bool $useOverride = true): bool
    {
        $expected = self::secret($botToken, $useOverride);
        $provided = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
        return $expected !== '' && is_string($provided) && $provided !== ''
            && hash_equals($expected, $provided);
    }

    public static function enforce(string $botToken, bool $useOverride = true): void
    {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !self::valid($botToken, $useOverride)) {
            http_response_code(403);
            exit('Unauthorized access');
        }
    }
}
