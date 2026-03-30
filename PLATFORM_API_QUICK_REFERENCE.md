# Platform Publishing API - Quick Reference

## Base URL
```
/api/v1
```

## Authentication
All endpoints require JWT token in Authorization header:
```
Authorization: Bearer <token>
```

---

## Platform Account Management

### 1. Get Supported Platforms
**Endpoint:** `GET /accounts/platforms`

**Response:**
```json
{
  "code": "OK",
  "data": [
    {
      "id": "wechat",
      "name": "微信公众号",
      "icon": "💬",
      "credentialFields": ["appId", "appSecret"],
      "description": "需要AppID和AppSecret"
    },
    {
      "id": "baijiahao",
      "name": "百家号",
      "icon": "📰",
      "credentialFields": ["accessToken"],
      "description": "需要百家号开放平台AccessToken"
    },
    {
      "id": "toutiao",
      "name": "头条号",
      "icon": "📱",
      "credentialFields": ["accessToken"],
      "description": "需要头条号开放平台AccessToken"
    },
    {
      "id": "zhihu",
      "name": "知乎",
      "icon": "🔍",
      "credentialFields": ["cookie", "columnId"],
      "description": "需要登录Cookie和专栏ID（可选）"
    },
    {
      "id": "xiaohongshu",
      "name": "小红书",
      "icon": "📕",
      "credentialFields": ["cookie"],
      "description": "需要登录Cookie"
    }
  ]
}
```

---

### 2. List All Accounts
**Endpoint:** `GET /accounts`

**Query Parameters:**
- `platform` (optional): Filter by platform (wechat|baijiahao|toutiao|zhihu|xiaohongshu)
- `group` (optional): Filter by group name

**Example:**
```
GET /accounts?platform=wechat&group=医学组
```

**Response:**
```json
{
  "code": "OK",
  "data": [
    {
      "id": "uuid-123",
      "tenantId": "tenant-uuid",
      "platform": "wechat",
      "accountName": "Medical Journal Tips",
      "accountId": "wx1234567890",
      "credentials": {
        "appId": "wx12****7890",
        "appSecret": "abcd****1234"
      },
      "status": "active",
      "isVerified": true,
      "groupName": "医学组",
      "metadata": {},
      "lastPublishedAt": "2026-03-30T10:30:00Z",
      "createdAt": "2026-03-29T15:20:00Z",
      "updatedAt": "2026-03-30T10:30:00Z"
    }
  ]
}
```

---

### 3. Create Account
**Endpoint:** `POST /accounts`

**Request Body:**
```json
{
  "platform": "wechat",
  "accountName": "Medical Journal Tips",
  "credentials": {
    "appId": "wx1234567890",
    "appSecret": "abcdef1234567890"
  },
  "groupName": "医学组"
}
```

**Platform-Specific Credentials:**

#### WeChat
```json
{
  "appId": "string (required)",
  "appSecret": "string (required)",
  "accessToken": "string (optional, cached)",
  "tokenExpiresAt": "ISO timestamp (optional)"
}
```

#### Baijiahao
```json
{
  "accessToken": "string (required)"
}
```

#### Toutiao
```json
{
  "accessToken": "string (required)"
}
```

#### Zhihu
```json
{
  "cookie": "string (required)",
  "columnId": "string (optional)"
}
```

#### Xiaohongshu
```json
{
  "cookie": "string (required)"
}
```

**Response:**
```json
{
  "code": "OK",
  "data": {
    "id": "uuid-123",
    "tenantId": "tenant-uuid",
    "platform": "wechat",
    "accountName": "Medical Journal Tips",
    "credentials": {
      "appId": "wx12****7890",
      "appSecret": "abcd****1234"
    },
    "status": "active",
    "isVerified": true,
    "verifyError": null,
    "groupName": "医学组",
    "metadata": {},
    "lastPublishedAt": null,
    "createdAt": "2026-03-30T10:45:00Z",
    "updatedAt": "2026-03-30T10:45:00Z"
  },
  "message": "Medical Journal Tips 添加成功，凭证验证通过"
}
```

---

### 4. Update Account
**Endpoint:** `PATCH /accounts/:id`

**Request Body (all optional):**
```json
{
  "accountName": "New Account Name",
  "credentials": {
    "appId": "new_appid",
    "appSecret": "new_secret"
  },
  "groupName": "new_group",
  "status": "disabled"
}
```

**Response:** Updated account object

---

### 5. Delete Account
**Endpoint:** `DELETE /accounts/:id`

**Response:**
```json
{
  "code": "OK",
  "data": {
    "id": "uuid-123"
  }
}
```

---

### 6. Verify Credentials
**Endpoint:** `POST /accounts/:id/verify`

**Response:**
```json
{
  "code": "OK",
  "data": {
    "valid": true,
    "error": null
  }
}
```

Or on failure:
```json
{
  "code": "OK",
  "data": {
    "valid": false,
    "error": "错误码 40001: invalid credential"
  }
}
```

---

## Content Publishing

### 7. Publish to Multiple Accounts
**Endpoint:** `POST /publish`

**Request Body:**
```json
{
  "contentId": "content-uuid-here",
  "accountIds": [
    "account-uuid-1",
    "account-uuid-2",
    "account-uuid-3"
  ],
  "options": {
    "author": "Dr. Smith",
    "digest": "Essential tips for medical research",
    "coverImageUrl": "https://example.com/cover.jpg"
  }
}
```

**Parameters:**
- `contentId` (required): UUID of content to publish
- `accountIds` (required): Array of account UUIDs (at least 1)
- `options.author` (optional): Author name (default: "BossMate AI")
- `options.digest` (optional): Content summary (default: first 50 chars of title)
- `options.coverImageUrl` (optional): Cover image URL for platforms that support it

**Response:**
```json
{
  "code": "OK",
  "data": {
    "results": [
      {
        "accountId": "account-uuid-1",
        "accountName": "Medical Channel",
        "platform": "wechat",
        "success": true,
        "publishId": "123456789",
        "mediaId": "media_abc123",
        "url": null,
        "error": null
      },
      {
        "accountId": "account-uuid-2",
        "accountName": "Health Tips",
        "platform": "baijiahao",
        "success": true,
        "publishId": "987654321",
        "mediaId": null,
        "url": null,
        "error": null
      },
      {
        "accountId": "account-uuid-3",
        "accountName": "Daily News",
        "platform": "toutiao",
        "success": false,
        "publishId": null,
        "mediaId": null,
        "url": null,
        "error": "Token expired, please revalidate credentials"
      }
    ],
    "summary": {
      "total": 3,
      "success": 2,
      "failed": 1
    }
  },
  "message": "发布完成：2 成功，1 失败"
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "code": "BAD_REQUEST",
  "message": "Invalid request parameters"
}
```

### 404 Not Found
```json
{
  "code": "NOT_FOUND",
  "message": "账号不存在"
}
```

### 401 Unauthorized
```json
{
  "code": "UNAUTHORIZED",
  "message": "Invalid or expired token"
}
```

### 500 Internal Server Error
```json
{
  "code": "INTERNAL_ERROR",
  "message": "Server error occurred"
}
```

---

## Common Workflows

### Workflow 1: Add New Account and Test
```bash
# 1. Get platform info
curl -H "Authorization: Bearer TOKEN" \
  https://app.bossmate.com/api/v1/accounts/platforms

# 2. Create account
curl -X POST -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "wechat",
    "accountName": "My Account",
    "credentials": {
      "appId": "xxx",
      "appSecret": "yyy"
    }
  }' \
  https://app.bossmate.com/api/v1/accounts

# 3. Verify credentials (if verification failed during creation)
curl -X POST -H "Authorization: Bearer TOKEN" \
  https://app.bossmate.com/api/v1/accounts/{ACCOUNT_ID}/verify
```

### Workflow 2: Publish Content
```bash
# 1. Get list of active accounts
curl -H "Authorization: Bearer TOKEN" \
  'https://app.bossmate.com/api/v1/accounts?platform=wechat&group=医学组'

# 2. Publish to selected accounts
curl -X POST -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contentId": "CONTENT_ID",
    "accountIds": ["ACCOUNT_ID_1", "ACCOUNT_ID_2"],
    "options": {
      "author": "AI Assistant"
    }
  }' \
  https://app.bossmate.com/api/v1/publish

# 3. Check distribution records for details
curl -H "Authorization: Bearer TOKEN" \
  'https://app.bossmate.com/api/v1/distribution-records?contentId=CONTENT_ID'
```

### Workflow 3: Update Credentials
```bash
# 1. Update credentials for an account
curl -X PATCH -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "credentials": {
      "appId": "new_appid",
      "appSecret": "new_secret"
    }
  }' \
  https://app.bossmate.com/api/v1/accounts/{ACCOUNT_ID}

# 2. Verify the new credentials work
curl -X POST -H "Authorization: Bearer TOKEN" \
  https://app.bossmate.com/api/v1/accounts/{ACCOUNT_ID}/verify
```

---

## Rate Limiting
- No explicit rate limiting implemented
- Individual platform APIs have their own limits
- Implement circuit breaker for failing accounts

## Credential Security
- Credentials are masked in API responses (shows only first 4 and last 4 characters)
- Store sensitive data securely (consider encryption at DB level)
- Never log full credentials
- Rotate credentials regularly for security

## Status Codes Reference
- `active`: Account ready to publish
- `disabled`: Account manually disabled
- `expired`: Credentials expired (revalidation needed)

---

*Last Updated: 2026-03-30*
