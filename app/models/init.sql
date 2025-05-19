-- Using a single sequence for all tables
CREATE SEQUENCE IF NOT EXISTS my_sequence START 100000;

CREATE TABLE IF NOT EXISTS Users (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY, 
  profile_image VARCHAR(255),
  name VARCHAR(255),
  email VARCHAR(255),
  password VARCHAR(255),  
  device_id VARCHAR(255),  
  role VARCHAR(255),
  signup_type VARCHAR(255),
  phone_number VARCHAR(20),
  verification_code VARCHAR(10), 
  block_status BOOLEAN DEFAULT false, 
  deleted_status BOOLEAN DEFAULT false, 
  deleted_at TIMESTAMP, 
  created_at timestamp DEFAULT NOW(),
  updated_at timestamp DEFAULT NOW()
); 

CREATE TABLE IF NOT EXISTS images (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY, 
  user_id INT REFERENCES Users(id),
  cloudinary_id VARCHAR(100),
  url TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS user_numbers (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY, 
  user_id INTEGER REFERENCES Users(id),
  number VARCHAR(255),
  country VARCHAR(255),
  number_type VARCHAR(255),
  capabilities TEXT,
  price DECIMAL,
  created_at timestamp DEFAULT NOW(),
  updated_at timestamp DEFAULT NOW()
); 

CREATE TABLE IF NOT EXISTS subscriptions (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY, 
  plan_id VARCHAR(255) NOT NULL,
  customer_id VARCHAR(255) NOT NULL,
  subscription_id VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL
);

-- New tables for Twilio Push Notification System

-- Table to store device tokens for push notifications
-- Removed UNIQUE constraint on device_token to allow duplicates
CREATE TABLE IF NOT EXISTS device_tokens (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY,
  user_id INTEGER REFERENCES Users(id),
  email VARCHAR(255), 
  device_token VARCHAR(255) NOT NULL,
  platform VARCHAR(50) NOT NULL,
  device_name VARCHAR(255),
  app_version VARCHAR(50),
  last_updated timestamp DEFAULT NOW(),
  created_at timestamp DEFAULT NOW()
);

-- Table to link Twilio numbers with user accounts for routing
CREATE TABLE IF NOT EXISTS twilio_number_mapping (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY,
  user_id INTEGER REFERENCES Users(id),
  email VARCHAR(255),
  twilio_number VARCHAR(255) NOT NULL,
  friendly_name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at timestamp DEFAULT NOW(),
  updated_at timestamp DEFAULT NOW()
);

-- Table to log call events for analytics and debugging
CREATE TABLE IF NOT EXISTS call_logs (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY,
  call_sid VARCHAR(255) NOT NULL,
  from_number VARCHAR(255),
  to_number VARCHAR(255),
  user_id INTEGER REFERENCES Users(id),
  direction VARCHAR(50),
  status VARCHAR(50),
  duration INTEGER,
  notification_sent BOOLEAN DEFAULT false,
  notification_timestamp timestamp,
  started_at timestamp,
  ended_at timestamp,
  created_at timestamp DEFAULT NOW()
);

-- Table to log SMS message events
CREATE TABLE IF NOT EXISTS message_logs (
  id INT NOT NULL DEFAULT nextval('my_sequence') PRIMARY KEY,
  message_sid VARCHAR(50) NOT NULL,  -- Twilio Message SID
  from_number VARCHAR(20) NOT NULL,  -- Sender phone number
  to_number VARCHAR(20) NOT NULL,    -- Recipient phone number
  body TEXT,                         -- Message content
  status VARCHAR(20) NOT NULL,       -- Message status (sent, delivered, received, failed, etc.)
  direction VARCHAR(10) NOT NULL,    -- 'inbound' or 'outbound'
  media_url TEXT,                    -- URLs of any media attached to the message (images, etc.)
  read_at TIMESTAMP,                 -- When the message was read by the recipient (for inbound messages)
  delivered_at TIMESTAMP,            -- When the message was delivered (based on Twilio webhook)
  user_id INTEGER REFERENCES Users(id), -- Associated user ID
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),  -- When the message was sent or received
  updated_at TIMESTAMP DEFAULT NOW()  -- Last update time (for status updates)
);

-- Indices for message_logs
CREATE INDEX IF NOT EXISTS idx_message_logs_from_to ON message_logs(from_number, to_number);
CREATE INDEX IF NOT EXISTS idx_message_logs_message_sid ON message_logs(message_sid);
CREATE INDEX IF NOT EXISTS idx_message_logs_unread ON message_logs(to_number, direction, read_at) 
WHERE read_at IS NULL AND direction = 'inbound';
CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON message_logs(created_at);