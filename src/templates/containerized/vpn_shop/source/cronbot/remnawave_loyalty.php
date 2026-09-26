<?php
require_once __DIR__ . '/_init.php';
rx_cron_boot('remnawave_loyalty', 3600);

ini_set('error_log', 'error_log');
if (!rx_cron_require_or_skip('remnawave_loyalty', [
    __DIR__ . '/../config.php',
    __DIR__ . '/../botapi.php',
    __DIR__ . '/../panels.php',
    __DIR__ . '/../function.php',
])) {
    return;
}
if (!rx_cron_db_ready('remnawave_loyalty')) {
    return;
}
if (is_file(__DIR__ . '/../vendor/autoload.php')) {
    require __DIR__ . '/../vendor/autoload.php';
}

$RW_TIER_GOLD = 5;
$RW_TIER_SILVER = 3;
$RW_TIER_BRONZE = 1;

try {
    $stmt = $pdo->prepare("SHOW TABLES LIKE 'remnawave_users'");
    $stmt->execute();
    if (count($stmt->fetchAll()) === 0) {
        return;
    }
} catch (Throwable $e) {
    error_log("[REMNAWAVE-LOYALTY] table check failed | " . $e->getMessage());
    return;
}

try {
    $stmt = $pdo->prepare("SELECT * FROM remnawave_users WHERE status = 'active' AND panel_user_id IS NOT NULL AND panel_user_id <> '' ORDER BY id ASC LIMIT 200");
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
} catch (Throwable $e) {
    error_log("[REMNAWAVE-LOYALTY] fetch failed | " . $e->getMessage());
    return;
}

if (!is_array($rows) || count($rows) === 0) {
    return;
}

$counts = array();
foreach ($rows as $row) {
    try {
        $namePanel = (string) ($row['name_panel'] ?? '');
        $idOrder = (string) ($row['id_order'] ?? '');
        if ($namePanel === '' || $idOrder === '') {
            continue;
        }
        $panel = select("marzban_panel", "*", "name_panel", $namePanel, "select");
        if (!is_array($panel) || ($panel['type'] ?? '') !== 'remnawave') {
            continue;
        }
        $inv = select("invoice", "*", "id_invoice", $idOrder, "select");
        $buyer = is_array($inv) ? (string) ($inv['id_user'] ?? '') : '';
        if ($buyer === '') {
            continue;
        }
        if (!isset($counts[$buyer])) {
            $c = $pdo->prepare("SELECT COUNT(*) FROM remnawave_users r JOIN invoice i ON i.id_invoice = r.id_order WHERE i.id_user = :b AND r.status = 'active'");
            $c->execute([':b' => $buyer]);
            $counts[$buyer] = (int) $c->fetchColumn();
        }
        $cnt = $counts[$buyer];
        $tier = $cnt >= $RW_TIER_GOLD ? 'GOLD' : ($cnt >= $RW_TIER_SILVER ? 'SILVER' : ($cnt >= $RW_TIER_BRONZE ? 'BRONZE' : ''));
        if ($tier === '') {
            continue;
        }
        if ((string) ($row['remna_tier'] ?? '') === $tier) {
            continue;
        }
        $res = function_exists('remnawave_set_tag') ? remnawave_set_tag($namePanel, (string) $row['username'], $tier) : ['status' => 'Unsuccessful'];
        if (($res['status'] ?? '') === 'successful') {
            $upd = $pdo->prepare("UPDATE remnawave_users SET remna_tier = :t WHERE id = :id");
            $upd->execute([':t' => $tier, ':id' => $row['id']]);
        }
    } catch (Throwable $e) {
        error_log("[REMNAWAVE-LOYALTY] " . $e->getMessage());
        continue;
    }
}
