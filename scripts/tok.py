"""Print the stored web token (admin/dev helper)."""
import sqlite3

conn = sqlite3.connect("data/app.db" if __name__ == "__main__" else "data/app.db")
print(conn.execute("SELECT value FROM settings WHERE key='web_token'").fetchone()[0])