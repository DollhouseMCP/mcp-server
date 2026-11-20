# Fail closed unless binary build info binds the exact reviewed local source.
$1 == "dep" && $2 == "github.com/go-jose/go-jose/v3" { bad = 1 }
$1 == "=>" && $2 == "github.com/go-jose/go-jose/v3" { bad = 1 }
$1 == "dep" && $2 == "github.com/caddyserver/caddy/v2" {
    seen++
    if ($3 != "v2.11.9") bad = 1
    if (getline <= 0 || $1 != "=>" || $2 != "../caddy-overlay" || $3 != "(devel)" || NF != 3) bad = 1
}
END { if (seen != 1 || bad) exit 1 }
