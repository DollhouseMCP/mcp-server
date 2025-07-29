# DollhouseMCP API Workflow Architecture

## Complete System Architecture

```mermaid
graph TB
    subgraph "User Clients"
        UC1[Claude Desktop]
        UC2[VS Code + Continue]
        UC3[ChatGPT]
        UC4[Gemini]
        UC5[Other MCP Clients]
    end
    
    subgraph "MCP Server Core"
        MS1[DollhouseMCP Server]
        MS2[Tool Registry]
        MS3[Request Handler]
    end
    
    subgraph "Security Layer"
        SL1[TokenManager]
        SL2[ContentValidator]
        SL3[RateLimiter]
        SL4[URLValidator]
        SL5[SecurityAuditor]
        SL6[SecureToken]
    end
    
    subgraph "Business Logic"
        BL1[PersonaManager]
        BL2[MarketplaceManager]
        BL3[PersonaExporter]
        BL4[PersonaImporter]
        BL5[PersonaSharer]
        BL6[UpdateManager]
    end
    
    subgraph "External Services"
        ES1[GitHub API]
        ES2[DollhouseMCP/personas Repo]
        ES3[NPM Registry]
        ES4[External URLs]
    end
    
    subgraph "Data Storage"
        DS1[Local Personas Dir]
        DS2[Environment Variables]
        DS3[Cache Layer]
        DS4[Audit Logs]
    end
    
    UC1 --> MS1
    UC2 --> MS1
    UC3 --> MS1
    UC4 --> MS1
    UC5 --> MS1
    
    MS1 --> MS2
    MS2 --> MS3
    MS3 --> SL1
    MS3 --> SL2
    MS3 --> SL3
    
    SL1 --> BL2
    SL2 --> BL1
    SL3 --> BL5
    SL4 --> BL4
    SL5 --> DS4
    
    BL1 --> DS1
    BL2 --> ES1
    BL3 --> SL6
    BL4 --> ES4
    BL5 --> ES1
    BL6 --> ES3
    
    ES1 --> ES2
    
    style SL1 fill:#ff9999
    style SL2 fill:#ff9999
    style SL3 fill:#ff9999
    style SL4 fill:#ff9999
    style SL5 fill:#ff9999
    style SL6 fill:#ffcc99
```

## Detailed API Flow Diagrams

### 1. Persona Creation and Sharing Flow

```mermaid
sequenceDiagram
    participant User
    participant MCP as MCP Server
    participant CV as ContentValidator
    participant TM as TokenManager
    participant PM as PersonaManager
    participant PS as PersonaSharer
    participant GH as GitHub API
    participant Repo as DollhouseMCP/personas

    User->>MCP: create_persona(name, content)
    MCP->>CV: validateContent(content)
    CV-->>MCP: ValidationResult
    
    alt Content Valid
        MCP->>PM: createPersona(metadata, content)
        PM->>PM: generateUniqueId()
        PM-->>MCP: PersonaCreated
        MCP-->>User: Success + PersonaID
        
        User->>MCP: share_persona(personaId)
        MCP->>TM: getGitHubToken()
        TM->>TM: validateTokenFormat()
        TM-->>MCP: Token | null
        
        alt Has Valid Token
            MCP->>PS: shareViaGist(persona, token)
            PS->>GH: POST /gists
            GH-->>PS: GistURL
            PS-->>MCP: ShareResult(gistUrl)
        else No Token
            MCP->>PS: shareViaBase64(persona)
            PS-->>MCP: ShareResult(base64Url)
        end
        
        MCP-->>User: ShareURL
    else Content Invalid
        MCP-->>User: ValidationErrors
    end
```

### 2. Marketplace Browse and Install Flow

```mermaid
sequenceDiagram
    participant User
    participant MCP as MCP Server
    participant RL as RateLimiter
    participant MM as MarketplaceManager
    participant GH as GitHub API
    participant Cache
    participant PM as PersonaManager

    User->>MCP: browse_collection(section, type)
    MCP->>RL: checkLimit(user, 'browse')
    RL-->>MCP: Allowed | RateLimited
    
    alt Rate Limit OK
        MCP->>Cache: get(section + type)
        
        alt Cache Hit
            Cache-->>MCP: CachedData
        else Cache Miss
            MCP->>MM: fetchContentType(section, type)
            MM->>GH: GET /repos/.../contents/{section}/{type}
            GH-->>MM: FileList
            MM->>Cache: set(section + type, data)
            MM-->>MCP: ContentList
        end
        
        MCP-->>User: Available Personas
        
        User->>MCP: install_persona(path)
        MCP->>MM: fetchPersona(path)
        MM->>GH: GET /repos/.../contents/{path}
        GH-->>MM: PersonaData(base64)
        MM->>MM: decodeBase64()
        MM->>PM: validateAndInstall(persona)
        PM-->>MCP: InstallResult
        MCP-->>User: Success | Error
    else Rate Limited
        MCP-->>User: 429 Rate Limit Error
    end
```

### 3. Security Validation Pipeline

```mermaid
graph LR
    subgraph "Input"
        I1[User Content]
        I2[External URL]
        I3[GitHub Token]
    end
    
    subgraph "Validation Layer"
        V1[Schema Validator]
        V2[Size Validator]
        V3[Token Scanner]
        V4[Malicious Pattern Detector]
        V5[URL Validator]
        V6[Unicode Normalizer]
    end
    
    subgraph "Risk Assessment"
        R1[Calculate Risk Score]
        R2[Check User Reputation]
        R3[Apply Trust Level Rules]
    end
    
    subgraph "Decision"
        D1{Risk Level}
        D2[Auto-Approve]
        D3[Manual Review]
        D4[Auto-Reject]
    end
    
    subgraph "Audit"
        A1[Log Decision]
        A2[Update Reputation]
        A3[Alert if Needed]
    end
    
    I1 --> V1
    I1 --> V2
    I1 --> V3
    I1 --> V4
    I1 --> V6
    I2 --> V5
    I3 --> V3
    
    V1 --> R1
    V2 --> R1
    V3 --> R1
    V4 --> R1
    V5 --> R1
    V6 --> R1
    
    R1 --> R2
    R2 --> R3
    R3 --> D1
    
    D1 -->|Low| D2
    D1 -->|Medium| D3
    D1 -->|High| D4
    
    D2 --> A1
    D3 --> A1
    D4 --> A1
    D4 --> A3
    
    A1 --> A2
    
    style V3 fill:#ff9999
    style V4 fill:#ff9999
    style V5 fill:#ff9999
    style D4 fill:#ff6666
```

### 4. Token Lifecycle Management

```mermaid
stateDiagram-v2
    [*] --> EnvVar: GITHUB_TOKEN set
    
    EnvVar --> Validation: getGitHubToken()
    
    Validation --> FormatCheck: Check regex pattern
    FormatCheck --> Invalid: Fail
    FormatCheck --> Valid: Pass
    
    Invalid --> [*]: Return null
    
    Valid --> SecureToken: Create SecureToken
    SecureToken --> Encrypted: Encrypt in memory
    
    Encrypted --> InUse: use() callback
    InUse --> APICall: Make GitHub API call
    APICall --> ScopeCheck: Validate scopes
    
    ScopeCheck --> Sufficient: Has required scopes
    ScopeCheck --> Insufficient: Missing scopes
    
    Sufficient --> Success: Operation proceeds
    Insufficient --> Failure: Operation blocked
    
    InUse --> Cleanup: Finally block
    Cleanup --> Cleared: Memory overwritten
    Cleared --> [*]
    
    Success --> [*]
    Failure --> [*]
```

## API Endpoints and Security Controls

### MCP Tool APIs

| Tool | Security Controls | Rate Limit | Auth Required |
|------|------------------|------------|---------------|
| `list_personas` | None | 100/min | No |
| `activate_persona` | Content validation | 50/min | No |
| `create_persona` | Full validation pipeline | 10/min | No |
| `edit_persona` | Schema validation | 20/min | No |
| `share_persona` | Token validation, content scan | 5/min | Optional |
| `import_persona` | URL validation, content scan | 10/min | No |
| `browse_marketplace` | Cache layer | 30/min | No |
| `search_marketplace` | Input sanitization | 20/min | No |
| `install_persona` | Full validation pipeline | 10/min | No |
| `submit_persona` | Full security gates | 2/min | Yes |

### External API Interactions

#### GitHub API

- **Endpoints Used**:
  - `GET /user` - Token validation
  - `POST /gists` - Share personas
  - `GET /gists/{id}` - Import shared personas
  - `GET /repos/{owner}/{repo}/contents` - Browse marketplace
  - `POST /repos/{owner}/{repo}/issues` - Submit personas

- **Security Measures**:
  - Bearer token authentication
  - Rate limit tracking
  - Error message sanitization
  - Timeout protection (10s)

#### NPM Registry

- **Endpoints Used**:
  - `GET /-/package/@mickdarling/dollhousemcp/dist-tags` - Check versions

- **Security Measures**:
  - Read-only access
  - Version validation
  - No authentication required

## Data Flow Security

### Sensitive Data Handling

```mermaid
graph TB
    subgraph "Sensitive Data Sources"
        S1[Environment Variables]
        S2[GitHub Tokens]
        S3[User Identities]
    end
    
    subgraph "Protection Layers"
        P1[SecureToken Wrapper]
        P2[Redaction Functions]
        P3[Encryption at Rest]
        P4[Memory Clearing]
    end
    
    subgraph "Usage Points"
        U1[API Calls]
        U2[Logging]
        U3[Error Messages]
    end
    
    S1 --> P1
    S2 --> P1
    S3 --> P2
    
    P1 --> U1
    P2 --> U2
    P2 --> U3
    P1 --> P4
    
    style S2 fill:#ff9999
    style P1 fill:#99ff99
    style P2 fill:#99ff99
```

## Security Monitoring Dashboard

### Real-time Metrics

- API calls per minute by endpoint
- Rejection rate by security gate
- Token validation failures
- Rate limit violations
- Suspicious pattern detections

### Alerts Configuration

```yaml
alerts:
  - name: "High Rejection Rate"
    condition: "rejection_rate > 0.3"
    window: "5m"
    severity: "warning"
    
  - name: "Token Brute Force"
    condition: "token_validation_failures > 10"
    window: "1h"
    severity: "critical"
    
  - name: "Malicious Content Detected"
    condition: "malicious_patterns > 0"
    window: "immediate"
    severity: "critical"
```

## Integration Points

### Future Integrations

1. **Webhook System**
   - Real-time notifications
   - Third-party integrations
   - Security event streaming

2. **API Gateway**
   - Additional rate limiting
   - Geographic restrictions
   - DDoS protection

3. **CDN Integration**
   - Cached marketplace content
   - Geographic distribution
   - Additional security layer

## Conclusion

This architecture provides comprehensive security coverage across all API touchpoints while maintaining the frictionless user experience that's core to DollhouseMCP's value proposition. The layered security approach ensures defense-in-depth, and the monitoring systems provide early warning of potential threats.
