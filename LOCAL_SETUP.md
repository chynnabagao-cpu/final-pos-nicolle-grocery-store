# Local Setup Guide for Lorna Store POS

To run this application locally in VS Code, follow these steps:

## Prerequisites

1.  **Node.js**: Install the latest LTS version from [nodejs.org](https://nodejs.org/).
2.  **MySQL**: Install MySQL Server locally (e.g., via MySQL Installer, XAMPP, or Docker).
3.  **VS Code**: Ensure you have Visual Studio Code installed.

## Setup Steps

1.  **Clone/Download the Code**:
    Open the project folder in VS Code.

2.  **Install Dependencies**:
    Open the VS Code terminal (`Ctrl + ` or `View > Terminal`) and run:
    ```bash
    npm install
    ```

3.  **Configure Environment Variables**:
    Create a file named `.env` in the root directory and add your MySQL credentials:
    ```env
    DB_HOST=localhost
    DB_PORT=3306
    DB_USER=root
    DB_PASSWORD=your_password_here
    DB_NAME=pos_db
    JWT_SECRET=your_super_secret_key_here
    ```
    *Note: The application will automatically attempt to create the `pos_db` database if it doesn't exist.*

4.  **Run the Application**:
    In the terminal, run the development server:
    ```bash
    npm run dev
    ```
    The server will start at `http://localhost:3000`.

5.  **Access the App**:
    Open your browser and navigate to `http://localhost:3000`.
    - **Default Admin Credentials**:
        - **Username**: `admin`
        - **Password**: `admin123`
    - *(Note: These are automatically created on the first run)*

## Troubleshooting

- **EADDRINUSE: address already in use (Port 3000)**:
    If you see this error, another process is using port 3000. You have two options:
    
    1.  **Change the port**:
        In your terminal, run:
        ```bash
        # For Windows (Command Prompt)
        set PORT=3001 && npm run dev
        
        # For Windows (PowerShell)
        $env:PORT=3001; npm run dev
        ```
    2.  **Kill the process using port 3000**:
        ```bash
        # For Windows (Command Prompt)
        netstat -ano | findstr :3000
        # Look for the PID (the number at the end) and run:
        taskkill /PID <PID_NUMBER> /F
        ```

- **MySQL Connection Error**: Ensure your MySQL service is running and the credentials in `.env` match your local setup.
- **Port Conflict**: If port 3000 is in use, you can change the port in `server.ts` or set a `PORT` env variable.
- **Missing Images**: Ensure the `uploads/` directory exists (it should be created automatically).
