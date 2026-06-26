-- Draft schema for the MVP backend.
-- Use real encryption for phone storage and a keyed hash for phone_fingerprint.

CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  openid VARCHAR(128) NOT NULL UNIQUE,
  phone_encrypted VARBINARY(512) NULL,
  industry VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL
);

CREATE TABLE customers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  name VARCHAR(64) NOT NULL,
  phone_encrypted VARBINARY(512) NULL,
  phone_fingerprint VARCHAR(128) NULL,
  company VARCHAR(128) NULL,
  region VARCHAR(128) NULL,
  wechat_remark VARCHAR(128) NULL,
  tags JSON NULL,
  is_temporary BOOLEAN NOT NULL DEFAULT TRUE,
  last_trade_at DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_customers_user_name (user_id, name),
  UNIQUE KEY uniq_customers_user_phone (user_id, phone_fingerprint)
);

CREATE TABLE quotations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  product_name VARCHAR(128) NOT NULL,
  spec VARCHAR(128) NULL,
  quantity DECIMAL(18, 3) NULL,
  unit VARCHAR(32) NULL,
  unit_price DECIMAL(18, 2) NULL,
  total_amount DECIMAL(18, 2) NULL,
  payment_method VARCHAR(64) NULL,
  delivery_date DATE NULL,
  quote_date DATE NOT NULL,
  valid_until DATE NULL,
  status VARCHAR(32) NOT NULL,
  remark TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_quotations_user_status_date (user_id, status, quote_date)
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  quotation_id BIGINT NULL,
  product_name VARCHAR(128) NOT NULL,
  spec VARCHAR(128) NULL,
  quantity DECIMAL(18, 3) NULL,
  unit VARCHAR(32) NULL,
  unit_price DECIMAL(18, 2) NULL,
  total_amount DECIMAL(18, 2) NULL,
  payment_method VARCHAR(64) NULL,
  order_date DATE NOT NULL,
  required_delivery_date DATE NULL,
  expected_ship_date DATE NULL,
  actual_ship_date DATE NULL,
  status VARCHAR(32) NOT NULL,
  logistics_info TEXT NULL,
  remark TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_orders_user_delivery (user_id, required_delivery_date, status)
);

CREATE TABLE receivables (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  order_id BIGINT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  due_date DATE NULL,
  status VARCHAR(32) NOT NULL,
  paid_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  dunning_count INT NOT NULL DEFAULT 0,
  last_dunning_date DATE NULL,
  remark TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  INDEX idx_receivables_user_due (user_id, due_date, status)
);

CREATE TABLE payment_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  receivable_id BIGINT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  paid_at DATE NOT NULL,
  remark TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dunning_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  receivable_id BIGINT NOT NULL,
  method VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_progress (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pending_notes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  original_text TEXT NOT NULL,
  guessed_intent VARCHAR(32) NOT NULL,
  guessed_fields JSON NULL,
  missing_fields JSON NULL,
  low_confidence_fields JSON NULL,
  source VARCHAR(32) NOT NULL,
  reason VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL
);

CREATE TABLE ai_parse_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  input_source VARCHAR(32) NOT NULL,
  original_text TEXT NOT NULL,
  parse_result JSON NOT NULL,
  action VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
