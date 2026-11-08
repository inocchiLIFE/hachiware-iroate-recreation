// Keep the incorrect answer on screen until the player has compared both colors.
window.showAnswerComparison = function (section, round, onNext, isLast) {
  const panel = document.createElement('section');
  panel.className = 'answer-comparison';
  panel.setAttribute('aria-label', '選んだ色と正解の比較');

  const title = document.createElement('h2');
  title.textContent = '色を見比べてみよう';
  panel.append(title);

  const row = document.createElement('div');
  row.className = 'answer-comparison__row';
  for (const [label, color] of [['あなたが選んだ子', round.base.hex], ['正解の子', round.oddHex]]) {
    const item = document.createElement('div');
    item.className = 'answer-comparison__item';
    const caption = document.createElement('strong');
    caption.textContent = label;
    const character = document.createElement('div');
    character.className = 'answer-comparison__character';
    const ear = document.createElement('span');
    ear.className = 'answer-comparison__ear';
    ear.style.backgroundColor = color;
    const img = document.createElement('img');
    img.src = new URL('./img/hachiware-base.png', document.baseURI).href;
    img.alt = '';
    character.append(ear, img);
    const hex = document.createElement('span');
    hex.className = 'answer-comparison__hex';
    hex.textContent = color;
    item.append(caption, character, hex);
    row.append(item);
  }
  panel.append(row);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'answer-comparison__next';
  next.textContent = isLast ? '結果を見る' : '次の問題へ';
  next.addEventListener('click', () => {
    panel.remove();
    onNext();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, { once: true });
  panel.append(next);
  section.append(panel);
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
