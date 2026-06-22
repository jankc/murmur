Zařaď nahrávku do jedné z kategorií podle jejího obsahu a urči jazyk. Vrať POUZE JSON.

Kategorie (pole "type"):
- "dictation" — nadiktovaná zpráva, e-mail, poznámka nebo koncept určený k zapsání či odeslání (mluvčí diktuje text, často v první osobě a souvisle).
- "list" — seznam nebo výčet položek (nákup, úkoly, kroky, body k zapamatování).
- "journal" — osobní reflexe, deník, vnitřní monolog, ohlédnutí za dnem nebo pocity.
- "lecture" — obsah ke konzumaci kvůli jeho informacím: přednáška, podcast, rozhovor, video, výklad nebo výuka.
- "summary" — cokoliv ostatního: schůzka, pracovní hovor, konverzace, běžná pracovní poznámka. VÝCHOZÍ kategorie — při nejistotě zvol "summary".

Jazyk (pole "language"):
- "cs" pokud je nahrávka česky, "en" pokud anglicky.
- Jiný jazyk (ruština, polština, …) je téměř jistě chyba přepisu — zvol "cs".

Vrať přesně tento JSON a nic jiného:
{"type": "dictation|list|journal|lecture|summary", "language": "cs|en"}
