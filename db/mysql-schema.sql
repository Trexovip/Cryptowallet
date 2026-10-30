-- KryvonWallet — MySQL/MariaDB schema (validated on MariaDB 10.11).
-- This is the target schema for running the app on MySQL. It mirrors the SQLite schema,
-- with VARCHAR on indexed/compared columns and BIGINT AUTO_INCREMENT primary keys.

CREATE TABLE IF NOT EXISTS users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(190) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'staff',       -- admin | staff | customer
  is_active TINYINT NOT NULL DEFAULT 1,
  customer_type VARCHAR(20),                        -- depositor | remittance
  auto_approve_limit DOUBLE,
  phone VARCHAR(40),
  pay_token VARCHAR(64),
  created_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wallets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chain VARCHAR(20) NOT NULL DEFAULT 'tron',
  address VARCHAR(80) UNIQUE NOT NULL,
  enc_privkey VARCHAR(512) NOT NULL,
  wtype VARCHAR(20) NOT NULL,                       -- deposit | treasury | disbursement | fee
  label VARCHAR(190) DEFAULT '',
  owner_user_id BIGINT,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_wallets_owner (owner_user_id),
  INDEX idx_wallets_wtype (wtype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS movements (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(30) NOT NULL,                        -- deposit_in | gas_fund | sweep | topup | disburse_out | treasury_out | gas_swap
  chain VARCHAR(20) DEFAULT 'tron',
  token VARCHAR(20) DEFAULT 'USDT',
  from_address VARCHAR(80),
  to_address VARCHAR(80),
  amount VARCHAR(40) NOT NULL,
  tx_hash VARCHAR(128),
  status VARCHAR(20) DEFAULT 'pending',             -- pending | confirmed | failed
  wallet_id BIGINT,
  initiated_by BIGINT,
  note VARCHAR(255) DEFAULT '',
  usd_rate VARCHAR(40),
  created_at VARCHAR(40) NOT NULL,
  confirmed_at VARCHAR(40),
  INDEX idx_mv_kind (kind),
  INDEX idx_mv_wallet (wallet_id),
  INDEX idx_mv_tx (tx_hash),
  INDEX idx_mv_to (to_address),
  INDEX idx_mv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_whitelist (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  address VARCHAR(80) NOT NULL,
  label VARCHAR(190) DEFAULT '',
  is_active TINYINT NOT NULL DEFAULT 1,
  created_by BIGINT,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_wl_customer (customer_id),
  INDEX idx_wl_address (address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS disbursement_requests (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  staff_user_id BIGINT NOT NULL,
  customer_id BIGINT,
  to_address VARCHAR(80) NOT NULL,
  amount VARCHAR(40) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  approved_by BIGINT,
  from_wallet_id BIGINT,
  tx_hash VARCHAR(128),
  reason VARCHAR(255) DEFAULT '',
  idempotency_key VARCHAR(80),
  first_approver BIGINT,
  created_at VARCHAR(40) NOT NULL,
  resolved_at VARCHAR(40),
  INDEX idx_dr_customer (customer_id),
  INDEX idx_dr_tx (tx_hash),
  INDEX idx_dr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS address_book (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(190) DEFAULT '',
  address VARCHAR(80) NOT NULL,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_by BIGINT,
  created_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_staff (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_cs_customer (customer_id),
  INDEX idx_cs_staff (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  sender_user_id BIGINT,
  sender_role VARCHAR(20),
  sender_name VARCHAR(190),
  body TEXT,
  kind VARCHAR(20) DEFAULT 'text',                  -- text | receipt | ack
  ref_tx VARCHAR(128),
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_msg_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(190) DEFAULT '',
  key_hash VARCHAR(255) NOT NULL,
  prefix VARCHAR(40) NOT NULL,
  scopes VARCHAR(190) DEFAULT '',
  created_by BIGINT,
  is_active TINYINT NOT NULL DEFAULT 1,
  last_used VARCHAR(40),
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_ak_prefix (prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(255) DEFAULT '',
  ip VARCHAR(64) DEFAULT '',
  created_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_usage (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event VARCHAR(30) NOT NULL,
  ref VARCHAR(128),
  amount VARCHAR(40),
  period VARCHAR(10) NOT NULL,
  reported TINYINT NOT NULL DEFAULT 0,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_bu_period (period),
  INDEX idx_bu_reported (reported)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
