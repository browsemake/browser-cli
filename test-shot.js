#!/usr/bin/env node

const http = require('http');
const fs = require('fs');

// Test data with WebP output and resizing
const testData = {
  url: 'https://example.com',
  width: 1200,
  height: 800,
  output_width: 600,
  output_format: 'webp',
  output_quality: 80
};

// Options for the HTTP request
const options = {
  hostname: 'localhost',
  port: 3030,
  path: '/shot',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

// Create the request
const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Content-Type: ${res.headers['content-type']}`);
  
  // Determine file extension based on content type
  let extension = 'png';
  if (res.headers['content-type'] === 'image/webp') {
    extension = 'webp';
  } else if (res.headers['content-type'] === 'image/jpeg') {
    extension = 'jpg';
  }
  
  const filename = `test-shot-result.${extension}`;
  
  // Save the screenshot to a file
  const fileStream = fs.createWriteStream(filename);
  res.pipe(fileStream);
  
  fileStream.on('finish', () => {
    console.log(`Screenshot saved as ${filename}`);
  });
});

// Handle errors
req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

// Write data to request body
req.write(JSON.stringify(testData));
req.end();

console.log('Sent request to /shot endpoint...');
console.log('Testing WebP output with resizing');