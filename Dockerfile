# Use Node.js base image
FROM node:20-slim

# Install system dependencies (Python3, pip, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies required by Dhan auto-login
RUN pip3 install --no-cache-dir --break-system-packages pycryptodome pyotp requests sourcedefender || \
    pip3 install --no-cache-dir pycryptodome pyotp requests sourcedefender

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Set environment variable for production
ENV NODE_ENV=production

# Build the application (SPA + Server)
RUN npm run build

# Expose port 3000
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
