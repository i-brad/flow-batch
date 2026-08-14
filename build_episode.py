#!/usr/bin/env python3
"""Rebuild episodes/09-namak.json from scene leads + the three shared style blocks."""
import json, os

HOUSE = ("Photorealistic cinematic still, an old joint-family house in Jhansi, Bundelkhand. "
         "Soot-darkened kitchen walls, brass and steel vessels, worn red-oxide floors, dim warm "
         "daylight falling in from an open courtyard. SATURATED deep ochre, brass-gold and dark "
         "green, high contrast, deep shadow. Fine film grain, 8k. No text, no lettering, no "
         "signage, no numerals anywhere in the image unless explicitly described as blurred past "
         "legibility.")

FIRE = ("Photorealistic cinematic still, north Indian winter night, shot as fire against cold. "
        "Enormous wood fires under huge blackened degchis, live orange flame and drifting sparks, "
        "thick smoke, breath visible in the cold air. The only warm light in frame is the fire; "
        "everything beyond it falls into deep blue-black. Extremely high contrast, saturated orange "
        "against near-black. Fine film grain, 8k. No text, no lettering, no signage, no numerals "
        "anywhere in the image unless explicitly described as blurred past legibility.")

WEDDING = ("Photorealistic cinematic still, a north Indian house wedding at night. Marigold "
           "garlands, hot pink and scarlet fabric, strings of white tube lights and bare bulbs on "
           "bamboo poles, a crowded shamiana. Bright, flat, over-lit and very saturated — the "
           "opposite of the fire scenes. Fine film grain, 8k. No text, no lettering, no signage, no "
           "numerals anywhere in the image unless explicitly described as blurred past legibility.")

STYLE = {"H": HOUSE, "F": FIRE, "W": WEDDING}

ANCHORS = {
    "sudha": "Sudha — a 43-year-old Indian woman from a small Bundelkhand city, medium build, strong forearms, greying hair pulled back into a low bun with a centre parting, a plain cotton saree in dull maroon worn with the pallu tucked into her waist for work, thin gold studs, a black thread on one wrist. Her hands are the point: broad, scarred, several old burn marks along the inner forearms, short nails. Her face is calm and closed; she watches people without expression.",
    "neha": "Neha — a 27-year-old Indian woman, city-raised, slim, hair in a neat high bun, a bright printed cotton kurta with leggings rather than a saree, small gold hoops, a smartphone usually in her hand or pocket. She holds herself apologetically and is always slightly too clean for a kitchen.",
    "rameshwar": "Rameshwar Prasad — a 70-year-old Indian man, thin, stooped, close-cropped white hair and a white stubble, a cream kurta over a dhoti with a brown Nehru waistcoat, thick black-framed glasses, a wooden walking stick he mostly carries rather than uses.",
    "mahesh": "Mahesh — a 45-year-old Indian man, heavy around the middle, thinning hair combed flat, a checked half-sleeve shirt tucked into dark trousers, a cheap steel watch. He is almost always looking at something other than the person speaking to him.",
    "shanti": "Shanti Devi — a 68-year-old Indian woman, very small and upright, white hair in a tight knot, a plain off-white cotton saree with a thin coloured border and the pallu over her head, heavy old silver toe-rings, no other jewellery. She sits very still and speaks rarely.",
    "pooja": "Pooja — a 26-year-old Indian woman, the youngest of the family, round-faced and lively, long oiled hair, in the wedding sequence a heavy scarlet and gold lehenga with full bridal jewellery and mehndi to the elbows; before that, ordinary salwar kameez.",
    "saroj": "Saroj Bua — a 75-year-old neighbourhood woman, very thin, deeply lined, white hair, a thick woollen shawl wrapped over a faded cotton saree, thick-lensed spectacles, sits cross-legged on the ground wherever she is.",
    "mishra": "Mishra the caterer — an Indian man of about 45, prosperous and brisk, a well-pressed pale blue shirt over a paunch, gold rings, a mobile phone in one hand, the confident manner of a man who is used to quoting prices in other people's houses.",
}

# (lead text, style key, anchors)
SCENES = [
 ("Extreme macro, low warm light. A small heap of coarse salt in the palm of a scarred working hand, a few grains spilling between the fingers, everything else falling into deep shadow.", "H", ["sudha"]),
 ("Wide interior, dim warm daylight from a courtyard door. A soot-blackened corner kitchen in an old house — a gas ring and a wood chulha side by side, rows of blackened brass and steel vessels on a shelf, a low wooden stool. SUDHA sits on the floor at the centre of it, rolling out rotis, entirely at home.", "H", ["sudha"]),
 ("Medium-wide exterior, dim daylight. SUDHA standing in a stranger's crowded courtyard directing a scene — one arm raised pointing at a stack of sacks, three other women and a young man turned toward her waiting. She is not dressed better than anyone there and is unmistakably the person in charge.", "H", ["sudha"]),
 ("Interior night, single bulb. Two women sitting on the floor against a wall away from a gathering — a very old woman talking with her hands, and SUDHA beside her, younger, leaning in, listening hard. A steel plate of half-eaten food forgotten between them.", "H", ["sudha"]),
 ("Macro close-up, dim indoor light. A folded cash envelope, a wrapped saree in cellophane and a steel serving bowl being placed down onto a wooden shelf by a scarred hand — and a second, older, smaller hand entering frame from the other side to take them.", "H", []),
 ("Wide interior, dim warm daylight. A family seated around a low dining table mid-meal, seen from the kitchen doorway — RAMESHWAR at the head, MAHESH beside him, SHANTI at the far end, two younger people with their backs to us. The near edge of frame is the dark kitchen doorway they are being watched from.", "H", ["rameshwar", "mahesh", "shanti"]),
 ("Medium two-shot, dim kitchen daylight. NEHA standing beside SUDHA at the kitchen counter, slightly too clean for the room, watching SUDHA's hands work. SUDHA is not looking at her. Genuine warmth in the younger woman's posture.", "H", ["sudha", "neha"]),
 ("Medium shot, kitchen daylight. NEHA cooking at a gas ring with a smartphone propped against a steel container in front of her, screen turned away from camera, her whole attention on the pan. A clean measured line of ingredients in small bowls beside her.", "H", ["neha"]),
 ("Tight close-up across a dinner table, warm overhead light. RAMESHWAR mid-sentence with a spoon still raised, eyebrows up, genuinely delighted, entirely unaware. Blurred figures around him at the edges of frame.", "H", ["rameshwar"]),
 ("Extreme close-up, hard low firelight from a gas ring below. SUDHA's face while working, lit from underneath, expression completely blank, eyes not on the pan. The most unreadable image in the episode.", "H", ["sudha"]),
 ("Medium shot from behind and above, very low light. SUDHA sitting on the floor in the dark inner corner of the kitchen between the wall and a stack of vessels, knees drawn up, head down, one hand over her mouth. A bright doorway far behind her with people moving past it, out of focus.", "H", ["sudha"]),
 ("Wide interior, night, one bulb. The kitchen after everyone has gone — cleared surfaces, a stack of washed plates, a switched-off stove, and SUDHA standing alone in the middle of the room with her arms at her sides, doing nothing at all.", "H", ["sudha"]),
 ("Extreme macro. Salt dissolving into clear simmering water, the grains vanishing as they sink, a spoon withdrawing from frame. Almost abstract.", "H", []),
 ("Wide interior, blue pre-dawn light, one warm point. SUDHA alone in the kitchen at half past five lighting the gas, the room otherwise entirely dark, the rest of the house asleep beyond an open door.", "H", ["sudha"]),
 ("Macro close-up, kitchen daylight. A pot of kadhi that has curdled and split — the yellow liquid separated into watery whey and grainy curds, unmistakably ruined. A wooden spoon standing in it. No people in frame.", "H", []),
 ("Wide interior, warm daylight. A family room mid-preparation — a suitcase open on a bed, fabric spread over every surface, a sweet-box on a table. POOJA sitting cross-legged in the middle of it laughing at something off-frame, SUDHA at the edge of the room folding something, watching her.", "H", ["sudha", "pooja"]),
 ("Wide interior, evening lamp light. The family seated around a room mid-discussion — RAMESHWAR talking with one hand raised, MAHESH nodding, others listening. SUDHA is in the frame but at the very edge, standing, holding a tea tray, and no one is looking at her.", "H", ["sudha", "rameshwar", "mahesh"]),
 ("Tight two-shot, evening light. RAMESHWAR turned toward NEHA and gesturing warmly at her, NEHA half-rising, surprised and pleased. Between and behind them, out of focus, SUDHA still standing with the tray.", "H", ["rameshwar", "neha", "sudha"]),
 ("Wide exterior, courtyard daylight. MISHRA seated comfortably on a chair mid-explanation with one hand open, RAMESHWAR and NEHA on chairs facing him. At the far edge of frame, standing in a doorway, small, SUDHA. The empty fourth chair is visible and nobody is in it.", "H", ["mishra", "rameshwar", "neha", "sudha"]),
 ("Tight close-up, courtyard daylight, shallow focus. SUDHA's face in a doorway at the moment a number lands — no expression, no movement, only the eyes changing. Everything behind her thrown completely out of focus.", "H", ["sudha"]),
 ("Wide interior, hard shaft of daylight. A dark disused storeroom in an old house with a door standing newly open, one blade of white light falling across stacked trunks and dusty vessels. No people in frame.", "H", []),
 ("Wide exterior night, from behind and above. A flat rooftop in a small city, water tank and washing line, the town's low roofs and one distant temple spire beyond. SUDHA sitting alone on the parapet wrapped in a shawl, very small in the frame, under an enormous cold sky.", "H", ["sudha"]),
 ("Two-shot, night, roof. MAHESH sitting beside SUDHA on the parapet, a foot of space between them, both facing out over the town rather than at each other. His posture is not unkind. It is simply absent.", "H", ["sudha", "mahesh"]),
 ("Tight close-up, night, one warm light from a stairwell. MAHESH's face while genuinely trying to remember — not defensive, not guilty, just searching and finding nothing. This is the whole marriage in one frame.", "H", ["mahesh"]),
 ("Wide interior night, from a doorway. A staircase in an old house with a man's back retreating down it, one hand on the rail, seen from above. Nobody follows him.", "H", ["mahesh"]),
 ("Medium two-shot, warm afternoon daylight through a window. POOJA standing in a scarlet and gold bridal lehenga in a small bedroom turning to show it, laughing, and SUDHA seated on the bed in her working saree with one hand raised, circling it in the air near the girl's head.", "H", ["sudha", "pooja"]),
 ("Tight two-shot, warm daylight. POOJA holding SUDHA's hand in both of hers, leaning in, entirely loving, mid-laugh. SUDHA laughing back — and the laugh does not reach anywhere above her mouth.", "H", ["sudha", "pooja"]),
 ("Split-feel wide shot, daylight. Through an open doorway: on one side the family's living room, comfortable, people sitting; on the other, through a second door, the dark kitchen with one working figure in it. Both visible in a single frame with the wall between them at the centre.", "H", ["sudha"]),
 ("Macro close-up, warm domestic light. A single steel plate of ordinary home food — dal, rice, two rotis, a vegetable — photographed straight down, plain and unstyled, exactly as it is served every day in millions of houses. Nobody in frame.", "H", []),
 ("Wide exterior. A stranger's courtyard at 2am — two enormous wood fires under blackened degchis, sparks going up, thick smoke, everything beyond the fires swallowed in blue-black. SUDHA stands at the nearer fire with a wooden paddle taller than she is, alone in the light.", "F", ["sudha"]),
 ("Two-shot. SAROJ BUA sitting cross-legged on the ground wrapped in a heavy shawl close to the fire, talking, and SUDHA standing over the degchi with the paddle suddenly stopped dead in her hands, looking down at the old woman.", "F", ["sudha", "saroj"]),
 ("Tight close-up. SAROJ BUA's lined face lit from one side by firelight, spectacles catching the flame, talking quite casually about something she has always assumed everyone knew.", "F", ["saroj"]),
 ("Wide exterior, from very far back. The courtyard at 4am — fires burned down to glowing red, one small figure still working beside them, the first thin grey of dawn along the bottom of the sky.", "F", ["sudha"]),
 ("Interior, cold early morning light from a small high window. SHANTI DEVI sitting upright on a cot in a bare room, already awake and dressed, and SUDHA standing just inside the doorway still in the smoke-smelling clothes she cooked in all night.", "H", ["shanti", "sudha"]),
 ("Tight close-up. SHANTI DEVI speaking, looking directly ahead, her face giving away almost nothing — the restraint of a woman who decided a very long time ago not to show anything.", "H", ["shanti"]),
 ("Two-shot, cold morning light. SHANTI DEVI on the cot and SUDHA now sitting on the floor in front of her rather than standing, looking up. The height reversal is the point.", "H", ["shanti", "sudha"]),
 ("Tight close-up. SUDHA sitting on the floor of the bare room, back against the cot's frame, looking at nothing, hands loose. Not crying. Rearranging twenty-two years.", "H", ["sudha"]),
 ("Wide exterior, daylight. The back of a courtyard converted into a catering camp — commercial gas burners, stacked tin drums, crates of vegetables, young men in aprons working. At the very edge of frame, in a doorway, SUDHA watching with her arms folded.", "W", ["sudha"]),
 ("Medium shot, harsh daylight. MISHRA standing with both palms raised and turned outward in refusal, RAMESHWAR facing him with a phone still in his hand, catering chaos behind them.", "W", ["mishra", "rameshwar"]),
 ("Wide exterior, harsh daylight. A courtyard in full panic — an old man with one hand on his head, a man on a phone walking in a circle, a car being reversed, decorations half up. On the far left edge, still and apart from all of it, SUDHA.", "W", ["sudha", "rameshwar", "mahesh"]),
 ("Tight two-shot. NEHA holding SUDHA's hand in both of hers in the middle of the chaos, talking fast and close, her face wrecked. SUDHA is listening and has not yet said anything.", "W", ["sudha", "neha"]),
 ("Medium close-up. SUDHA standing still in the middle of a courtyard full of moving people, looking at nothing, everyone around her blurred by motion.", "W", ["sudha"]),
 ("Tight two-shot, harsh daylight. RAMESHWAR standing in front of SUDHA with his mouth open on an unfinished word, one hand half-raised. SUDHA facing him level, calm, having just finished a sentence.", "W", ["rameshwar", "sudha"]),
 ("Medium close-up. SUDHA speaking, one hand slightly raised counting something off, entirely level, in her working saree in the middle of a wedding. Blurred faces around the edges of frame all turned to her.", "W", ["sudha"]),
 ("Tight close-up. RAMESHWAR's face in the long pause before he nods — an old man being asked for something that costs him more than the money.", "W", ["rameshwar"]),
 ("Wide exterior, dusk turning to night. Three wood fires being lit in a line in the back courtyard, SUDHA directing four other women, sacks and vegetables arriving, the first flames catching. Purposeful, fast, and completely different in energy from every earlier scene.", "F", ["sudha", "saroj"]),
 ("Wide exterior night, the signature composition. In the foreground, three roaring wood fires and one small woman with a long paddle silhouetted against them. Far behind, out of focus, the bright saturated blur of a lit wedding shamiana full of people. Two worlds in one frame, one of them dark.", "F", ["sudha"]),
 ("Wide exterior. An old man sitting alone on a plastic chair at the dark edge of the firelight, hands on his knees, watching four women work three fires. He is entirely outside the pool of light. Nobody is looking at him.", "F", ["rameshwar"]),
 ("Medium shot, harsh tube light. RAMESHWAR standing at a microphone on a small stage under marigold garlands, glasses off in one hand, mid-sentence, looking out at a crowd rather than down at a paper.", "W", ["rameshwar"]),
 ("Interior, ordinary daylight. MAHESH standing in a doorway with his back half-turned, one hand on the frame, not looking into the room. In the foreground, out of focus, a woman's hand holding a small folded stack of banknotes.", "H", ["mahesh"]),
 ("Medium close-up, daylight. SUDHA standing in her kitchen holding an old mobile phone to her ear, the other hand still holding a ladle, caught in the middle of ordinary work.", "H", ["sudha"]),
 ("Tight close-up. SUDHA's face in the two seconds after she has said it — waiting, braced for something that does not come.", "H", ["sudha"]),
 ("Wide exterior night. SUDHA at a fire in a stranger's courtyard again — the same composition as before, but she is now in a clean saree, standing straight, and two other women are working to her instruction rather than beside her.", "F", ["sudha"]),
 ("Wide interior, evening. The family's kitchen with NEHA at the stove alone, doing it badly and doing it anyway, a phone propped up beside her. The room is the same. The person in it is not.", "H", ["neha"]),
 ("Medium two-shot, kitchen daylight. SUDHA and NEHA side by side at the counter, SUDHA's scarred hand guiding NEHA's over a pan, both looking down at the same thing. Neither is looking at the other.", "H", ["sudha", "neha"]),
 ("Interior night, warm lamp light. SUDHA sitting on the edge of a cot with a phone held to her ear with her shoulder, both hands demonstrating something in the air in front of her to nobody.", "H", ["sudha"]),
 ("Wide exterior, dusk, from very high up. The rooftops of a small Indian city with dozens of kitchen chimneys and courtyards, cooking smoke rising from a hundred separate houses at the same hour. No individual person is identifiable.", "H", []),
 ("Extreme macro, warm light. A pinch of salt falling from three fingers into a pot, caught mid-air, each grain separately lit. The same gesture as the opening image of the episode, and it should be shot to match it.", "H", ["sudha"]),
 ("Wide interior, warm evening light. An ordinary family eating together at a table, and one of them turned toward the kitchen doorway saying something to a person standing in it. Nobody's face is the focus; the geometry — the turn of the head toward the doorway — is the whole image.", "H", []),
]

THUMBNAIL = ("Photorealistic cinematic still, SATURATED colour and extreme contrast, sharp focus. A "
 "north Indian house courtyard at night in winter. FOREGROUND, LEFT OF CENTRE: three enormous wood "
 "fires burning under huge blackened degchis, live orange flame and drifting sparks, thick smoke lit "
 "from within. Standing at the nearest fire, small and alone and seen almost in silhouette, SUDHA "
 "— a 43-year-old Indian woman in a dull maroon working saree with the pallu tucked in, gripping "
 "a wooden stirring paddle taller than she is, her face lit orange from below. FAR BACKGROUND, out of "
 "focus: the bright blur of a lit wedding shamiana strung with white bulbs and marigolds, full of "
 "seated guests in colourful clothes, unmistakably a celebration she is not part of. The whole middle "
 "of the frame is black. The composition must read at thumbnail size with the faces removed: one "
 "fire, one woman, one distant party. No text anywhere in the image. High detail, 8k.")

images = []
for i, (lead, style, anchors) in enumerate(SCENES, start=1):
    images.append({
        "id": f"scene_{i:02d}",
        "prompt": f"{lead} {STYLE[style]}",
        "anchors": anchors,
    })
images.append({"id": "thumbnail", "prompt": THUMBNAIL, "anchors": ["sudha"], "image_size": "4K"})

spec = {
    "episode": "09-namak",
    "defaults": {"model": "gemini-3.1-flash-image", "aspect_ratio": "16:9", "image_size": "2K"},
    "anchors": ANCHORS,
    "images": images,
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flow-batch", "episodes")
os.makedirs(out, exist_ok=True)
path = os.path.join(out, "09-namak.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(spec, f, ensure_ascii=False, indent=2)

print(f"wrote {path}")
print(f"scenes: {len(images)} (expected 60)")
assert len(images) == 60, "scene count mismatch"
missing = {a for im in images for a in im["anchors"]} - set(ANCHORS)
assert not missing, f"unknown anchors: {missing}"
print("all anchor references resolve")
