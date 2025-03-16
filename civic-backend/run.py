from app import create_app

app = create_app()

if __name__ == '__main__':
    # Only use debug mode for local development, not in production
    debug_mode = False
    app.run(host='0.0.0.0', port=5002, debug=debug_mode)