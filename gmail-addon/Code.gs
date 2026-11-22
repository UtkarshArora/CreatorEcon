// BrandCheck Gmail add-on: open a sponsorship email, get a cited green / yellow / red verdict in the sidebar.
// Set these two values (or Script Properties BACKEND_URL / ADDON_TOKEN) before deploying.
var BACKEND_URL = 'https://YOUR-APP.vercel.app'; // no trailing slash
var ADDON_TOKEN = 'paste-the-same-ADDON_TOKEN-you-set-in-Vercel';

var COLORS = { green: '#127a46', yellow: '#8a5a00', red: '#b42318' };
var SCORE = ['Clear', 'Minor', 'Caution', 'Serious'];

function cfg_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v || fallback;
}

function onHomepage() {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BrandCheck').setSubtitle('Know the brand before you sign'))
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
      'Open a sponsorship email and BrandCheck runs a live background check on the brand: ' +
      'is the sender real, do they pay creators, any lawsuits, recalls or backlash. Powered by You.com live web data.')))
    .build();
}

function onGmailMessage(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  return [runForMessage_(e.gmail.messageId)];
}

function onRetry(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var card = runForMessage_(e.parameters.messageId);
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card)).build();
}

function runForMessage_(messageId) {
  var msg = GmailApp.getMessageById(messageId);
  var input = 'From: ' + msg.getFrom() + '\nSubject: ' + msg.getSubject() + '\n\n' + msg.getPlainBody().slice(0, 8000);
  var res;
  try {
    res = UrlFetchApp.fetch(cfg_('BACKEND_URL', BACKEND_URL) + '/api/addon', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-brandcheck-token': cfg_('ADDON_TOKEN', ADDON_TOKEN) },
      payload: JSON.stringify({ input: input }),
      muteHttpExceptions: true
    });
  } catch (err) {
    return errorCard_(messageId, 'Could not reach BrandCheck: ' + err);
  }
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200) {
    return errorCard_(messageId, (body && body.error) || ('HTTP ' + res.getResponseCode()));
  }
  return verdictCard_(body);
}

function verdictCard_(r) {
  var color = COLORS[r.verdict] || '#17161a';
  var kind = r.verdictKind === 'scam' ? 'POSSIBLE SCAM' : r.verdictKind === 'thin' ? 'NOT ENOUGH INFO' :
    r.verdict === 'green' ? 'LOOKS SAFE' : r.verdict === 'yellow' ? 'CAUTION' : 'HIGH RISK';
  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BrandCheck: ' + r.brand)
      .setSubtitle('Checked in ' + r.seconds + 's with ' + r.youCalls + ' live You.com calls'));

  var top = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText('<font color="' + color + '"><b>● ' + kind + '</b></font>'))
    .addWidget(CardService.newTextParagraph().setText('<b>' + esc_(r.headline) + '</b>'));
  (r.reasons || []).forEach(function (x) { top.addWidget(CardService.newTextParagraph().setText('• ' + esc_(x))); });
  card.addSection(top);

  var sender = CardService.newCardSection().setHeader('Is this email really from ' + esc_(r.brand) + '?');
  var senderLabel = { verified: 'Sender verified', freemail: 'Free email address', lookalike: 'Lookalike domain', unrelated: 'Different domain', unknown: 'Sender not checked' }[r.sender.status];
  sender.addWidget(CardService.newDecoratedText().setTopLabel(senderLabel).setText(esc_(r.sender.email || 'unknown sender'))
    .setBottomLabel(r.sender.officialDomain ? 'Official site: ' + r.sender.officialDomain : 'No official site found').setWrapText(true));
  (r.flags || []).slice(0, 4).forEach(function (f) {
    sender.addWidget(CardService.newDecoratedText().setTopLabel(SCORE[f.severity]).setText(esc_(f.label)).setWrapText(true));
  });
  card.addSection(sender);

  if (r.categories && r.categories.length) {
    var checks = CardService.newCardSection().setHeader('Risk checks');
    r.categories.forEach(function (c) {
      checks.addWidget(CardService.newDecoratedText().setTopLabel(SCORE[c.score]).setText(c.name).setBottomLabel(c.summary).setWrapText(true));
    });
    card.addSection(checks);
  }

  if (r.sources && r.sources.length) {
    var src = CardService.newCardSection().setHeader('Sources');
    r.sources.forEach(function (s) {
      src.addWidget(CardService.newDecoratedText().setText(esc_(s.label).slice(0, 120)).setWrapText(true)
        .setOpenLink(CardService.newOpenLink().setUrl(s.url)));
    });
    card.addSection(src);
  }

  if (r.questions && r.questions.length) {
    var q = CardService.newCardSection().setHeader('Questions to ask before you sign').setCollapsible(true).setNumUncollapsibleWidgets(2);
    r.questions.forEach(function (x, i) { q.addWidget(CardService.newTextParagraph().setText((i + 1) + '. ' + esc_(x))); });
    card.addSection(q);
  }
  return card.build();
}

function errorCard_(messageId, text) {
  var retry = CardService.newAction().setFunctionName('onRetry').setParameters({ messageId: messageId });
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('BrandCheck'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText('Check failed: ' + esc_(String(text)).slice(0, 300)))
      .addWidget(CardService.newTextButton().setText('Try again').setOnClickAction(retry)))
    .build();
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
