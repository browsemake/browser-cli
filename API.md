# Browser CLI Daemon API

The Browser CLI Daemon exposes several endpoints for browser automation, navigation, content extraction, and interaction.

## Browser Control Endpoints

### Navigate to a URL
```
POST /goto
Content-Type: application/json

{
  "url": "https://example.com"
}
```

### Click an element
```
POST /click
Content-Type: application/json

{
  "selector": "#button-id",
  "position": "center" // Optional: "center", "top", "bottom", "left", "right"
}
```

### Type text
```
POST /type
Content-Type: application/json

{
  "selector": "#input-field",
  "text": "Hello World"
}
```

### Extract page content
```
GET /content
```

Returns the HTML content of the current page.

## Content Extraction Endpoints

### Extract page as JSON
```
GET /dom
```

Returns a structured JSON representation of the DOM with XPath mappings.

### Extract accessibility tree
```
GET /ax
```

Returns the accessibility tree of the current page.

## Session Management

### Get browser info
```
GET /info
```

Returns browser version, page count, and other session information.

### Close session
```
POST /shutdown
```

Gracefully shuts down the browser daemon.

### Notes

- The daemon maintains a persistent browser context that persists between requests
- Cookies and sessions are maintained across requests
- Most endpoints operate on the currently active browser tab
- The daemon supports tab management through dedicated endpoints

## Screenshot Endpoints

### Capture single screenshot
```
POST /shot
Content-Type: application/json

{
  "url": "https://example.com",
  "width": 1920,
  "height": 1080,
  "waitTime": 1000,
  "output_format": "png",
  "output_quality": 80
}
```

Returns the screenshot as an image buffer with appropriate Content-Type header.

### Capture multiple screenshots
```
POST /shot-multi
Content-Type: application/json

{
  "url": "https://example.com",
  "width": 1920,
  "waitTime": 1000,
  "output_format": "webp",
  "output_quality": 80,
  "outputs": [
    { "height": 720, "output_width": 640 },
    { "height": 1080, "output_width": 1280 }
  ]
}
```

Returns:
```json
{
  "images": [
    {
      "data": "base64-encoded-image...",
      "content_type": "image/webp",
      "height": 720,
      "width": 640
    }
  ]
}
```

The `/shot-multi` endpoint loads the page once and generates multiple screenshots with different dimensions. Each output specification can include:
- `height` - Crop to this height from the top of the page
- `output_width` - Resize to this width (maintains aspect ratio)
- `output_format` - Override format per output (png, jpg, webp)
- `output_quality` - Override quality per output (for webp/jpg)