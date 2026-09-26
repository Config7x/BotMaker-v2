<?php


declare(strict_types=1);

require_once __DIR__ . '/BaseHandler.php';

final class ServiceLocationsHandler extends BaseHandler
{
    public function handle(): void
    {
        $this->requireMethod('GET');

        $username = {{BRAND_NAME}}Input::string($this->data, 'username');
        if ($username === '') {
            {{BRAND_NAME}}Response::badRequest('username is required');
        }

        $invoice = {{BRAND_NAME}}Db::fetchOne(
            'SELECT * FROM invoice WHERE id_user = :u AND username = :n LIMIT 1',
            [':u' => $this->user['id'], ':n' => $username]
        );
        if ($invoice === null) {
            {{BRAND_NAME}}Response::notFound('Service not found');
        }

        $currentPanel = (string)($invoice['Service_location'] ?? '');
        $agent = (string)($this->user['agent'] ?? 'f');

        $rows = {{BRAND_NAME}}Db::fetchAll(
            "SELECT * FROM marzban_panel
              WHERE status = 'active'
                AND (agent = :agent OR agent = 'all')
                AND name_panel != :current",
            [':agent' => $agent, ':current' => $currentPanel]
        );

        $list = [];
        foreach ((is_array($rows) ? $rows : []) as $row) {
            if (($row['changeloc'] ?? '') === 'offchangeloc') continue;

            $hide = $this->decodeJsonField($row['hide_user'] ?? null);
            if (!empty($hide) && in_array((string)$this->user['id'], array_map('strval', $hide), true)) {
                continue;
            }

            $list[] = [
                'id'    => (string)$row['code_panel'],
                'name'  => (string)$row['name_panel'],
                'price' => (int)($row['priceChangeloc'] ?? 0),
            ];
        }

        $limitJson = json_decode((string)($this->setting['limitnumber'] ?? ''), true);
        $limitAll = (int)($limitJson['all'] ?? 0);
        $limitFreeMax = (int)($limitJson['free'] ?? 0);
        $limitEnforced = (int)($this->setting['statuslimitchangeloc'] ?? 0) === 1;
        $userLimitUsed = (int)($this->user['limitchangeloc'] ?? 0);

        {{BRAND_NAME}}Response::ok([
            'panels'      => $list,
            'is_free'     => !$limitEnforced || $userLimitUsed < $limitFreeMax,
            'limit_left'  => $limitEnforced ? max(0, $limitAll - $userLimitUsed) : null,
        ]);
    }
}
