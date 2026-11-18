import json
import sys

TEMPLATE, TARGET, PRIVATE_KEY, SHORT_ID = sys.argv[1:5]
SNI = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else ""
PORT = int(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else 0

with open(TEMPLATE, encoding="utf-8") as source:
    document = json.load(source)

for inbound in document["inbounds"]:
    settings = inbound.get("streamSettings", {}).get("realitySettings")
    if settings is None:
        continue
    if PORT > 0:
        inbound["port"] = PORT
    if SNI:
        settings["dest"] = f"{SNI}:443"
        settings["serverNames"] = [SNI]
    settings["privateKey"] = PRIVATE_KEY
    settings["shortIds"] = [SHORT_ID]

with open(TARGET, "w", encoding="utf-8") as destination:
    json.dump(document, destination, indent=2)
    destination.write("\n")
