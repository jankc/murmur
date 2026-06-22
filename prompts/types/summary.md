Shrnutí schůzky, pracovního hovoru, konverzace nebo běžné poznámky. Použij jen sekce, které
dávají smysl (např. vlastní poznámka většinou nemá rozhodnutí ani více řečníků).

# Shrnutí
- max 5 vět, pouze fakta

# Hlavní body
- krátké konkrétní body (max 1 věta)

# Nápady / myšlenky *(hlavně u vlastní poznámky)*
- nápady, postřehy nebo myšlenky, které zazněly

# Rozhodnutí a dohody
- explicitní rozhodnutí (u meetingu) nebo to, na čem se účastníci shodli (u rozhovoru)

# Úkoly
- [ ] co udělat (kdo, pokud je zřejmé)

# Připomínky *(jen pokud zazněly)*
- věci, na které je třeba nezapomenout

# Otevřené otázky
- nezodpovězené otázky

# Technické poznámky *(jen pokud jde o technický meeting)*
- technologie, architektura, nástroje

# Technická rozhodnutí *(jen pokud jde o technický meeting)*
- konkrétní technická řešení

# Rizika / problémy *(jen pokud jde o technický meeting)*
- možné blokery nebo nejasnosti

# Confidence
- jedno slovo: `vysoká`, `střední`, nebo `nízká`

---

# Příklad 1 — pracovní meeting

**Vstup:**
```
Tomáš: Musíme se rozhodnout, jestli použijeme Postgres nebo SQLite. Honza navrhuje Postgres kvůli replikaci.
Honza: Souhlasím, Postgres. Migraci udělám do pátku.
Tomáš: Dobře, jdeme do Postgresu. Ještě nevíme, jak vyřešíme zálohy.
```

**Výstup:**
```
# Volba databáze pro projekt

# Shrnutí
Tým se rozhodl použít Postgres místo SQLite kvůli replikaci. Honza udělá migraci do pátku. Otázka záloh zůstává otevřená.

# Rozhodnutí a dohody
- Použít Postgres místo SQLite

# Úkoly
- [ ] Honza — udělat migraci na Postgres do pátku

# Otevřené otázky
- Jak řešit zálohy databáze

# Technické poznámky
- Postgres zvolen kvůli podpoře replikace

# Confidence
střední
```

---

# Příklad 2 — vlastní poznámka (jeden mluvčí)

**Vstup:**
```
Tak si potřebuju zapamatovat, že do appky chci přidat dark mode. Napadlo mě udělat to přes systémové nastavení, ne vlastní přepínač. A taky pozor, prezentace pro klienta je už v pátek.
```

**Výstup:**
```
# Nápad na dark mode v appce

# Shrnutí
Poznámka k plánu přidat do aplikace dark mode a připomínka k páteční prezentaci pro klienta.

# Hlavní body
- Přidat do aplikace dark mode

# Nápady / myšlenky
- Dark mode řešit přes systémové nastavení, ne přes vlastní přepínač

# Připomínky
- Prezentace pro klienta je v pátek

# Confidence
vysoká
```
