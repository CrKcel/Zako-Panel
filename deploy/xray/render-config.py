import json
import sys

TEMPLATE, TARGET, PRIVATE_KEY, SHORT_ID = sys.argv[1:5]

with open(TEMPLATE, encoding="utf-8") as source:
    document = json.load(source)

for inbound in document["inbounds"]:
    settings = inbound.get("streamSettings", {}).get("realitySettings")
    if settings is None:
        continue
    settings["privateKey"] = PRIVATE_KEY
    settings["shortIds"] = [SHORT_ID]

with open(TARGET, "w", encoding="utf-8") as destination:
    json.dump(document, destination, indent=2)
    destination.write("\n")
