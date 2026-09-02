"""Small sample application used by ExplainIT tests."""
import json
import os


def load_config(path):
    """Read a JSON settings file and return it as a dictionary."""
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    data = json.loads(text)
    return data


def greet(name, excited=False):
    message = "Hello, " + name
    if excited:
        message += "!"
    return message


class Server:
    def __init__(self, port):
        self.port = port
        self.running = False

    def start(self):
        self.running = True
        print("listening on", self.port)

    def stop(self):
        self.running = False


def main():
    config = load_config(os.environ.get("APP_CONFIG", "config.json"))
    server = Server(config.get("port", 8080))
    server.start()
    print(greet(config.get("name", "world"), excited=True))


if __name__ == "__main__":
    main()
