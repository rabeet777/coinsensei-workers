#!/bin/bash

# CoinSensei Workers - Setup Verification Script
# This script checks if the environment is properly configured

set -e

echo "🔍 CoinSensei Workers - Setup Verification"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Node.js
echo -n "Checking Node.js version... "
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} $NODE_VERSION"
else
    echo -e "${RED}✗${NC} Node.js not found"
    exit 1
fi

# Check npm
echo -n "Checking npm... "
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓${NC} v$NPM_VERSION"
else
    echo -e "${RED}✗${NC} npm not found"
    exit 1
fi

# Check dependencies installed
echo -n "Checking node_modules... "
if [ -d "node_modules" ]; then
    echo -e "${GREEN}✓${NC} Dependencies installed"
else
    echo -e "${RED}✗${NC} Run 'npm install' first"
    exit 1
fi

# Check .env file
echo -n "Checking .env file... "
if [ -f ".env" ]; then
    echo -e "${GREEN}✓${NC} Found"
    
    # Check required variables
    source .env
    
    echo -n "  Checking SUPABASE_URL... "
    if [ -n "$SUPABASE_URL" ] && [ "$SUPABASE_URL" != "your-supabase-url-here" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC} Not configured"
    fi
    
    echo -n "  Checking SUPABASE_SERVICE_ROLE_KEY... "
    if [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && [ "$SUPABASE_SERVICE_ROLE_KEY" != "your-service-role-key-here" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC} Not configured"
    fi
else
    echo -e "${YELLOW}!${NC} Not found (copy from .env.example)"
fi

# Check TypeScript compilation
echo -n "Checking TypeScript compilation... "
if npx tsc --noEmit 2>/dev/null; then
    echo -e "${GREEN}✓${NC} No errors"
else
    echo -e "${RED}✗${NC} Compilation errors"
    exit 1
fi

# Check source files
echo -n "Checking source files... "
REQUIRED_FILES=(
    "src/index.ts"
    "src/config/env.ts"
    "src/config/supabase.ts"
    "src/chains/tron/tron.client.ts"
    "src/chains/tron/tron.usdt.parser.ts"
    "src/workers/deposit/tron.deposit.worker.ts"
    "src/utils/logger.ts"
    "src/utils/sleep.ts"
)

ALL_FOUND=true
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo -e "${RED}✗${NC} Missing: $file"
        ALL_FOUND=false
    fi
done

if [ "$ALL_FOUND" = true ]; then
    echo -e "${GREEN}✓${NC} All files present"
fi

# Check migration file
echo -n "Checking database migration... "
if [ -f "migrations/001_create_worker_tables.sql" ]; then
    echo -e "${GREEN}✓${NC} Found"
else
    echo -e "${RED}✗${NC} Missing migration file"
fi

echo ""
echo "=========================================="

# Final summary
if [ -f ".env" ]; then
    source .env
    if [ -n "$SUPABASE_URL" ] && [ "$SUPABASE_URL" != "your-supabase-url-here" ] && \
       [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && [ "$SUPABASE_SERVICE_ROLE_KEY" != "your-service-role-key-here" ]; then
        echo -e "${GREEN}✅ Setup looks good!${NC}"
        echo ""
        echo "Next steps:"
        echo "  1. Run database migration (see migrations/001_create_worker_tables.sql)"
        echo "  2. Configure TRON chain in database"
        echo "  3. Configure USDT asset in database"
        echo "  4. Add user wallet addresses"
        echo "  5. Run: npm start"
        echo ""
        echo "For detailed instructions, see QUICKSTART.md"
    else
        echo -e "${YELLOW}⚠️  Almost ready!${NC}"
        echo ""
        echo "Action required:"
        echo "  - Configure .env file with your Supabase credentials"
        echo ""
        echo "See QUICKSTART.md for setup instructions"
    fi
else
    echo -e "${YELLOW}⚠️  Setup incomplete${NC}"
    echo ""
    echo "Action required:"
    echo "  - Create .env file (copy from .env.example)"
    echo "  - Configure Supabase credentials"
    echo ""
    echo "See QUICKSTART.md for setup instructions"
fi

echo ""

