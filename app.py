"""
Heartful — a cozy little catching game.

A tiny, dependency-light Flask server whose only job is to serve the
single-page game and its static assets (CSS, JavaScript, images, sounds).

Run it with::

    pip install flask
    python app.py

then open the printed address (default: http://127.0.0.1:5000) in a browser.
"""

import os

from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def index():
    """Render the game's single page."""
    return render_template("index.html")


@app.after_request
def add_offline_friendly_headers(response):
    """Discourage aggressive caching during local development."""
    response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "1") not in ("0", "false", "False")

    print("\n  💗  Heartful is warming up...")
    print(f"  💗  Open  http://{host}:{port}  in your browser to play.\n")

    app.run(host=host, port=port, debug=debug)
