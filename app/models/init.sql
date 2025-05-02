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

CREATE TABLE  IF NOT EXISTS images (
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