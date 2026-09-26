<?php

if (!function_exists('rx_panel_valid_sale_predicate')) {
    function rx_panel_valid_sale_predicate()
    {
        return "(status = 'active' OR status = 'end_of_time' OR status = 'end_of_volume' OR status = 'sendedwarn' OR Status = 'send_on_hold') AND name_product != 'سرویس تست'";
    }
}

if (!function_exists('panelRealTotalRevenue')) {
    function panelRealTotalRevenue(string $panel): int
    {
        global $connect;
        $predicate = rx_panel_valid_sale_predicate();
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $invoiceRow = mysqli_fetch_assoc(mysqli_query($connect, "SELECT SUM(price_product) AS s FROM invoice WHERE $predicate AND Service_location = '$panelEsc'"));
        $ledgerRow = mysqli_fetch_assoc(mysqli_query($connect, "SELECT SUM(amount) AS s FROM sale_ledger WHERE Service_location = '$panelEsc'"));
        return (int)($invoiceRow['s'] ?? 0) + (int)($ledgerRow['s'] ?? 0);
    }
}

if (!function_exists('panelDailySalesAverage30d')) {
    function panelDailySalesAverage30d(string $panel): float
    {
        global $connect;
        $predicate = rx_panel_valid_sale_predicate();
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $since = time() - (30 * 86400);
        $invoiceRow = mysqli_fetch_assoc(mysqli_query($connect, "SELECT COALESCE(SUM(price_product),0) AS s FROM invoice WHERE $predicate AND Service_location = '$panelEsc' AND time_sell >= $since"));
        $ledgerRow = mysqli_fetch_assoc(mysqli_query($connect, "SELECT COALESCE(SUM(amount),0) AS s FROM sale_ledger WHERE Service_location = '$panelEsc' AND created_at >= $since"));
        $total = (float)($invoiceRow['s'] ?? 0) + (float)($ledgerRow['s'] ?? 0);
        return $total / 30;
    }
}

if (!function_exists('panelTopPerformingPlan')) {
    function panelTopPerformingPlan(string $panel): array
    {
        global $connect;
        $predicate = rx_panel_valid_sale_predicate();
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $row = mysqli_fetch_assoc(mysqli_query($connect, "SELECT name_product, COUNT(*) AS cnt FROM invoice WHERE $predicate AND Service_location = '$panelEsc' GROUP BY name_product ORDER BY cnt DESC LIMIT 1"));
        return [
            'name_product' => $row['name_product'] ?? null,
            'count' => (int)($row['cnt'] ?? 0),
        ];
    }
}

if (!function_exists('panelTrialAccountsIssued')) {
    function panelTrialAccountsIssued(string $panel, int $since): int
    {
        global $connect;
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $row = mysqli_fetch_assoc(mysqli_query($connect, "SELECT COUNT(*) AS c FROM invoice WHERE name_product = 'سرویس تست' AND Service_location = '$panelEsc' AND time_sell >= $since"));
        return (int)($row['c'] ?? 0);
    }
}

if (!function_exists('panelRenewalVolume')) {
    function panelRenewalVolume(string $panel, int $since): array
    {
        global $connect;
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $row = mysqli_fetch_assoc(mysqli_query($connect, "SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM sale_ledger WHERE Service_location = '$panelEsc' AND kind = 'renewal' AND created_at >= $since"));
        return [
            'count' => (int)($row['c'] ?? 0),
            'sum' => (int)($row['s'] ?? 0),
        ];
    }
}

if (!function_exists('panelAddOnUpgrades')) {
    function panelAddOnUpgrades(string $panel, int $since): array
    {
        global $connect;
        $panelEsc = mysqli_real_escape_string($connect, $panel);
        $row = mysqli_fetch_assoc(mysqli_query($connect, "SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM sale_ledger WHERE Service_location = '$panelEsc' AND kind IN ('volume','time') AND created_at >= $since"));
        return [
            'count' => (int)($row['c'] ?? 0),
            'sum' => (int)($row['s'] ?? 0),
        ];
    }
}

if (!function_exists('rx_panel_sales_metrics_block')) {
    function rx_panel_sales_metrics_block(string $panel): string
    {
        $revenue = number_format(panelRealTotalRevenue($panel));
        $dailyAvg = number_format(panelDailySalesAverage30d($panel));
        $topPlan = panelTopPerformingPlan($panel);
        $topPlanName = $topPlan['name_product'] ?? 'ندارد';
        $topPlanCount = number_format($topPlan['count']);
        $since24h = time() - 86400;
        $since30d = time() - (30 * 86400);
        $trials24h = number_format(panelTrialAccountsIssued($panel, $since24h));
        $trials30d = number_format(panelTrialAccountsIssued($panel, $since30d));
        $renew24h = panelRenewalVolume($panel, $since24h);
        $renew30d = panelRenewalVolume($panel, $since30d);
        $addon24h = panelAddOnUpgrades($panel, $since24h);
        $addon30d = panelAddOnUpgrades($panel, $since30d);

        return "‏──────────────
💵 «آمار مالی پنل»
‏──────────────

💰 مجموع فروش واقعی : {$revenue} تومان

📊 میانگین فروش روزانه (۳۰ روز) : {$dailyAvg} تومان

🏆 پرفروش‌ترین محصول : {$topPlanName} ({$topPlanCount} خرید)

🧪 اکانت تست صادر شده : {$trials24h} (۲۴ ساعت) / {$trials30d} (۳۰ روز)

🔄 حجم تمدید : {$renew24h['count']} عدد / " . number_format($renew24h['sum']) . " تومان (۲۴ ساعت) | {$renew30d['count']} عدد / " . number_format($renew30d['sum']) . " تومان (۳۰ روز)

➕ افزایش حجم/زمان : {$addon24h['count']} عدد / " . number_format($addon24h['sum']) . " تومان (۲۴ ساعت) | {$addon30d['count']} عدد / " . number_format($addon30d['sum']) . " تومان (۳۰ روز)";
    }
}
