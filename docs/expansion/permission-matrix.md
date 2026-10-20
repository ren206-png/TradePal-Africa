# Permission matrix

Generated from `src/auth/permissions.ts` by `npx tsx scripts/genPermissionMatrix.ts > docs/expansion/permission-matrix.md`. The code is the source of truth; `tests/permissions.test.ts` pins it. Authorization asks `canMerchant(role, permission)` / `canPlatform(role, permission)`, never role names.

Legacy WhatsApp roles map as: OWNER -> OWNER, STAFF -> SALES_CLERK (`membershipRoleForLegacyMerchantRole`).

## Merchant roles (inside one business)

| Permission | OWNER | MANAGER | SALES_CLERK | INVENTORY_OPERATOR | FINANCE_OPERATOR | RESTRICTED_SUPPORT |
|---|---|---|---|---|---|---|
| `sales:create` | yes | yes | yes | - | - | - |
| `sales:void` | yes | yes | - | - | - | - |
| `expenses:create` | yes | yes | yes | - | yes | - |
| `customers:manage` | yes | yes | yes | - | - | - |
| `debts:record` | yes | yes | yes | - | - | - |
| `debts:view` | yes | yes | yes | - | yes | yes |
| `inventory:view` | yes | yes | yes | yes | - | yes |
| `inventory:receive` | yes | yes | - | yes | - | - |
| `inventory:adjust` | yes | yes | - | yes | - | - |
| `prices:manage` | yes | yes | - | yes | - | - |
| `reports:view` | yes | yes | yes | - | yes | yes |
| `finance:close_day` | yes | yes | - | - | yes | - |
| `finance:export` | yes | yes | - | - | yes | - |
| `finance:reconcile` | yes | yes | - | - | yes | - |
| `payments:view` | yes | yes | - | - | yes | yes |
| `payments:connect_provider` | yes | - | - | - | - | - |
| `staff:manage` | yes | yes | - | - | - | - |
| `settings:manage` | yes | - | - | - | - | - |
| `business:manage` | yes | - | - | - | - | - |

## Platform admin roles (TradePal staff; no merchant permission by default)

| Permission | SUPER_ADMIN | OPERATOR | SUPPORT | ANALYST | Step-up (flag `adminStepUp`) |
|---|---|---|---|---|---|
| `admin:view_overview` | yes | yes | yes | yes | - |
| `admin:view_system_health` | yes | yes | - | yes | - |
| `admin:view_orgs` | yes | yes | yes | yes | - |
| `admin:view_audit_log` | yes | yes | yes | yes | - |
| `admin:view_merchant_financials` | yes | yes | yes | - | yes |
| `admin:manage_flags` | yes | yes | - | - | yes |
| `admin:manage_global_flags` | yes | - | - | - | yes |
| `admin:suspend_org` | yes | - | - | - | yes |
| `admin:revoke_staff` | yes | - | yes | - | yes |
| `admin:reverse_transaction` | yes | yes | - | - | yes |
| `admin:resolve_exception` | yes | yes | - | - | yes |
| `admin:replay_dead_letter` | yes | yes | - | - | yes |
| `admin:pause_job_class` | yes | yes | - | - | yes |
| `admin:manage_subscriptions` | yes | - | - | - | yes |
| `admin:moderate_listings` | yes | - | - | - | yes |
| `admin:resolve_support_case` | yes | yes | yes | - | yes |
| `admin:delete_synthetic_org` | yes | - | - | - | yes |
| `admin:flip_forecast_gate` | yes | - | - | - | yes |
| `admin:manage_admins` | yes | - | - | - | yes |

Notes: viewing a merchant's financial data additionally needs a recorded support-access reason when flag `adminSupportAccessRequired` is on. The existing admin routes keep their original role checks (SUPER_ADMIN / SUPPORT); the platform permission is layered on top for the new panels. Regenerate with the command above if the matrix changes.

