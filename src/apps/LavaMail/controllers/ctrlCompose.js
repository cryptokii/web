module.exports = ($rootScope, $scope, $stateParams, $translate, $interval,
							   utils, consts, co, router, composeHelpers, textAngularHelpers, crypto,
							   user, contacts, inbox, Manifest, Contact, hotkey, ContactEmail, Email, Attachment) => {
	$scope.toolbar = [
		['pre'],
		['h1', 'h2', 'h3'],
		['bold', 'italics', 'underline'],
		['justifyLeft', 'justifyCenter', 'justifyRight'],
		['ul', 'ol'],
		['submit']
	];
	$scope.taggingTokens = 'SPACE|,|/';

	$scope.form = {
		person: {},
		selected: {
			to: [],
			cc: [],
			bcc: [],
			from: contacts.myself
		},
		fromEmails: [contacts.myself],
		subject: '',
		body: ''
	};

	$scope.isSent = false;
	$scope.isSending = false;
	$scope.isWarning = false;
	$scope.isError = false;
	$scope.isXCC = false;
	$scope.isCC = false;
	$scope.isBCC = false;

	$scope.isDraftWarning = false;
	$scope.isSkipWarning = user.settings.isSkipComposeScreenWarning;
	$scope.attachments = [];

	$scope.isToolbarShown = false;

	let hiddenContacts = {};
	let draftId = $stateParams.draftId;
	let isExistingDraft = !!draftId;
	let replyThreadId = $stateParams.replyThreadId;
	let replyEmailId = $stateParams.replyEmailId;
	let isReplyAll = $stateParams.isReplyAll;
	let forwardEmailId = $stateParams.forwardEmailId;
	let forwardThreadId = $stateParams.forwardThreadId;
	let toEmail = $stateParams.to;
	let publicKey = null;
	let autoSaveInterval = null;

	let manifest = null;
	let newHiddenContact = null;

	const translations = {
		LB_ATTACHMENT_STATUS_READING: '',
		LB_ATTACHMENT_STATUS_READING_ERROR: '',
		LB_ATTACHMENT_STATUS_DELETING_ERROR: '',
		LB_ATTACHMENT_STATUS_ENCRYPTING: '',
		LB_ATTACHMENT_STATUS_ENCRYPTING_ERROR: '',
		LB_ATTACHMENT_STATUS_FORMATTING: '',
		LB_ATTACHMENT_STATUS_FORMATTING_ERROR: '',
		LB_ATTACHMENT_STATUS_UPLOADING: '',
		LB_ATTACHMENT_STATUS_UPLOADING_ERROR: '',
		LB_ATTACHMENT_STATUS_UPLOADED: '',
		LB_NO_SUBJECT: ''
	};
	$translate.bindAsObject(translations, 'LAVAMAIL.COMPOSE');

	let subject = '';
	let body = '<br/>';

	function isChanged() {
		return $scope.form.selected.to.length > 0 ||
		$scope.form.selected.cc.length > 0 ||
		$scope.form.selected.bcc.length > 0 ||
		$scope.form.subject.trim() != subject ||
		$scope.form.body.trim() != body;
	}

	const saveAsDraft = () => co(function *(){
		let meta = {
			publicKey: publicKey,
			to: $scope.form.selected.to ? $scope.form.selected.to.map(e => e.email) : [],
			cc: $scope.form.selected.cc ? $scope.form.selected.cc.map(e => e.email) : [],
			bcc: $scope.form.selected.bcc ? $scope.form.selected.bcc.map(e => e.email) : [],
			subject: $scope.form.subject
		};

		if (draftId) {
			yield inbox.updateDraft(draftId, meta, body);
		} else {
			draftId = yield inbox.createDraft(meta, body);
		}
	});

	const processAttachment = (attachmentStatus) => co(function *() {
		attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_READING;
		attachmentStatus.isCancelled = false;

		try {
			yield attachmentStatus.attachment.read();
		} catch (err) {
			attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_READING_ERROR;
			throw err;
		} finally {
			if (attachmentStatus.isCancelled)
				throw new Error('cancelled');
		}

		attachmentStatus.status = '';

		try {
			attachmentStatus.ext = attachmentStatus.attachment.type.split('/')[0];
		} catch (err) {
			attachmentStatus.ext = 'file';
		}
	});

	co(function* () {
		console.log('compose initialize');
		let params = null;
		let draft = null;
		if (draftId) {
			draft = yield inbox.getDraftById(draftId);
			params = draft.meta;
		} else 
			params = $stateParams;

		publicKey = params.publicKey ? crypto.getPublicKeyByFingerprint(params.publicKey) : null;

		console.log('compose initialize, draft:', draft,  publicKey);

		if (publicKey) {
			let blob = new Blob([publicKey.armor()], {type: 'text/plain'});
			blob.lastModifiedDate = publicKey.primaryKey.created;
			blob.name = utils.getEmailFromAddressString(publicKey.users[0].userId.userid) + '.asc';
			const attachmentStatus = {
				attachment: new Attachment(blob)
			};
			attachmentStatus.processingPromise = processAttachment(attachmentStatus);
			$scope.attachments.push(attachmentStatus);
		}

		$scope.$bind('contacts-changed', () => {
			console.log('compose initialize contacts-changed binding');

			let toEmailContact = ContactEmail.transform(toEmail);

			let people = [...contacts.people.values()];
			let map = new Map();

			const addHiddenEmails = (checkEmail) => {
				people.reduce((a, c) => {
					if (c.hiddenEmail && c.hiddenEmail.email && checkEmail(c.hiddenEmail))
						a.set(c.hiddenEmail.email, c.hiddenEmail);

					return a;
				}, map);
			};

			const addEmails = (checkEmail) => {
				people.reduce((a, c) => {
					c.privateEmails.forEach(e => {
						if (e.email && checkEmail(e))
							a.set(e.email, e);
					});
					c.businessEmails.forEach(e => {
						if (e.email && checkEmail(e))
							a.set(e.email, e);
					});

					return a;
				}, map);
			};

			addEmails(e => e.isSecured() && e.isStar);
			addEmails(e => e.isSecured() && !e.isStar);
			addEmails(e => !e.isSecured() && e.isStar);
			addEmails(e => !e.isSecured() && !e.isStar);

			addHiddenEmails(e => e.isSecured());
			addHiddenEmails(e => !e.isSecured());

			if (toEmailContact)
				map.set(toEmailContact.email, toEmailContact);

			$scope.people = [...map.values()];
			console.log('$scope.people', $scope.people);

			co(function *() {
				const signature = user.settings.isSignatureEnabled && user.settings.signatureHtml ? user.settings.signatureHtml : '';
				if (forwardEmailId) {
					let emails = [yield inbox.getEmailById(forwardEmailId)];
					body = yield composeHelpers.buildForwardedTemplate(body, '', emails);
					subject = 'Fwd: ' + Email.getSubjectWithoutRe(emails[0].subject);
				}
				else
				if (forwardThreadId) {
					let emails = yield inbox.getEmailsByThreadId(forwardThreadId);
					body = yield composeHelpers.buildForwardedTemplate(body, '', emails);
					subject = 'Fwd: ' + Email.getSubjectWithoutRe(emails[0].subject);
				}
				else
				if (replyEmailId) {
					let email = yield inbox.getEmailById(replyEmailId);

					body = yield composeHelpers.buildRepliedTemplate(body, signature, [{
						date: email.date,
						name: email.from[0].name,
						address: email.from[0].address,
						body: email.body.data
					}]);
				} else
					body = yield composeHelpers.buildDirectTemplate(body, signature);

				if (replyThreadId && replyEmailId) {
					let thread = yield inbox.getThreadById(replyThreadId);
					let email = yield inbox.getEmailById(replyEmailId);

					let to = (isReplyAll ? thread.members : email.from)
						.map(m => ContactEmail.transform(m.address));


					subject = `Re: ${Email.getSubjectWithoutRe(thread.subject)}`;
					$scope.form = {
						person: {},
						selected: {
							to: draft ? ContactEmail.transform(draft.meta.to) : to,
							cc: draft ? ContactEmail.transform(draft.meta.cc) : [],
							bcc: draft ? ContactEmail.transform(draft.meta.bcc) : [],
							from: contacts.myself
						},
						fromEmails: [contacts.myself],
						subject: draft ? draft.meta.subject : subject,
						body: draft ? draft.body.data : body
					};
				} else {
					$scope.form = {
						person: {},
						selected: {
							to: draft ? ContactEmail.transform(draft.meta.to) : (toEmailContact ? [toEmailContact] : []),
							cc: draft ? ContactEmail.transform(draft.meta.cc) : [],
							bcc: draft ? ContactEmail.transform(draft.meta.bcc) : [],
							from: contacts.myself
						},
						fromEmails: [contacts.myself],
						subject: draft ? draft.meta.subject : subject,
						body: draft ? draft.body.data : body
					};
				}

				autoSaveInterval = $interval(() => {
					if (isExistingDraft || isChanged())
						saveAsDraft();
				}, consts.COMPOSE_AUTO_SAVE_INTERVAL);

				console.log('$scope.form', $scope.form);
			});
		});
	});

	$scope.onFileDrop = (file) => {
		if (file.type && file.type.startsWith('image'))
			return;

		const attachmentStatus = {
			attachment: new Attachment(file)
		};
		attachmentStatus.processingPromise = processAttachment(attachmentStatus);
		$scope.attachments.push(attachmentStatus);
	};

	$scope.deleteAttachment = (attachmentStatus, index) => co(function *() {
		attachmentStatus.isCancelled = true;

		try {
			yield attachmentStatus.processingPromise;
		} catch (err) {
			if (err.message != 'cancelled')
				throw err;
		}

		if (attachmentStatus.id)
			try {
				yield inbox.deleteAttachment(attachmentStatus.id);
			} catch (err) {
				attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_DELETING_ERROR;
				throw err;
			}

		$scope.attachments.splice(index, 1);
	});

	$scope.uploadAttachment = (attachmentStatus, keys) => co(function *() {
		const isSecured = Email.isSecuredKeys(keys);

		let envelope;
		attachmentStatus.status = isSecured ? translations.LB_ATTACHMENT_STATUS_ENCRYPTING : translations.LB_ATTACHMENT_STATUS_FORMATTING;
		try {
			envelope = yield Attachment.toEnvelope(attachmentStatus.attachment, keys);
		} catch (err) {
			attachmentStatus.status = isSecured ? translations.LB_ATTACHMENT_STATUS_ENCRYPTING_ERROR : translations.LB_ATTACHMENT_STATUS_FORMATTING_ERROR;
			throw err;
		} finally {
			if (attachmentStatus.isCancelled)
				throw new Error('cancelled');
		}

		let r;
		attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_UPLOADING;
		try {
			r = yield inbox.uploadAttachment(envelope);
			attachmentStatus.id = r.body.file.id;
			attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_UPLOADED;
		} catch (err) {
			attachmentStatus.status = translations.LB_ATTACHMENT_STATUS_UPLOADING_ERROR;
			throw err;
		} finally {
			if (attachmentStatus.isCancelled)
				throw new Error('cancelled');
		}
	});

	$scope.$watch('isSkipWarning', (o, n) => {
		if (o == n)
			return;

		user.update({isSkipComposeScreenWarning: $scope.isSkipWarning});
	});

	$scope.toggleIsSkipWarning = (event) => {
		$scope.isSkipWarning = !$scope.isSkipWarning;
	};

	$scope.isValid = () => $scope.__form.$valid &&
		$scope.form && $scope.form.selected.to.length > 0;

	$scope.send = () => co(function *() {
		$scope.isSending = true;
		try {
			if (!$scope.isValid())
				return;

			if (!$scope.form.subject)
				$scope.form.subject = translations.LB_NO_SUBJECT;

			$scope.isError = false;
			$scope.isWarning = false;

			yield $scope.attachments.map(a => a.processingPromise);

			let to = $scope.form.selected.to.map(e => e.email),
				cc = $scope.form.selected.cc.map(e => e.email),
				bcc = $scope.form.selected.bcc.map(e => e.email);

			let keys = yield composeHelpers.getKeys($scope.form.selected.to, $scope.form.selected.cc, $scope.form.selected.bcc);
			const isSecured = Email.isSecuredKeys(keys);

			yield $scope.attachments.map(attachmentStatus => $scope.uploadAttachment(attachmentStatus, keys));

			manifest = Manifest.create({
				fromEmail: user.styledEmail,
				to,
				cc,
				bcc,
				subject: $scope.form.subject
			});

			console.log('sending a candy', $scope.form.body);

			manifest.setBody($scope.form.body, 'text/html');
			for (let attachmentStatus of $scope.attachments)
				manifest.addAttachment(attachmentStatus.attachment.id,
					attachmentStatus.attachment.getBodyAsBinaryString(), attachmentStatus.attachment.name, attachmentStatus.attachment.type);

			try {
				let body = composeHelpers.cleanupOutboundEmail($scope.form.body);

				yield inbox.send({
					body: body,
					attachmentIds: $scope.attachments.map(a => a.id),
					threadId: replyThreadId
				}, manifest, keys);

				if (isSecured) {
					$scope.form.body = inbox.getMumbledFormattedBody();

					yield utils.sleep(consts.MUMBLE_SHOW_DELAY);

					yield $scope.confirm();
				} else if ($scope.isSkipWarning) {
					yield $scope.confirm();
				}
				else {
					$scope.isWarning = true;
				}
			} catch (err) {
				$scope.isError = true;
				throw err;
			}
		} finally {
			$scope.isSending = false;
		}
	});

	$scope.confirm = () => co(function *(){
		try {
			$scope.isWarning = false;

			yield inbox.confirmSend();

			yield manifest.getDestinationEmails()
				.filter(email => !contacts.getContactByEmail(email))
				.map(email => {
					let contact = new Contact({name: '$hidden'});
					contact.hiddenEmail = hiddenContacts[email];
					return contacts.createContact(contact);
				});

			manifest = null;

			$scope.isSent = true;

			if (draftId) {
				yield inbox.requestDelete(inbox.getCachedThreadById(draftId));
			}

			router.hidePopup();
		} catch (err) {
			$scope.isError = true;
			throw err;
		}
	});

	$scope.close = () => {
		if (!isExistingDraft && isChanged()) {
			$scope.isDraftWarning = true;
		}
		else {
			if (isExistingDraft && isChanged())
				saveAsDraft();
			router.hidePopup();
		}
	};

	$scope.saveDraft = () => co(function *(){
		yield saveAsDraft();

		router.hidePopup();
	});

	$scope.deleteDraft = () => co(function *(){
		if (draftId) {
			let t = inbox.getCachedThreadById(draftId);
			if (t)
				yield inbox.requestDelete(t);
			else
				yield inbox.deleteDraft(draftId);
		}

		router.hidePopup();
	});

	$scope.cancelClose = () => co(function *(){
		$scope.isDraftWarning = false;
	});

	$scope.reject = () => {
		$scope.isWarning = false;

		inbox.rejectSend();
		manifest = null;
	};

	$scope.addAttachment = (file) => {
		const attachmentStatus = {
			attachment: new Attachment(file)
		};
		attachmentStatus.processingPromise = processAttachment(attachmentStatus);
		$scope.attachments.push(attachmentStatus);
	};

	$scope.clearTo = () => $scope.form.selected.to = [];
	$scope.clearCC = () => $scope.form.selected.cc = [];
	$scope.clearBCC = () => $scope.form.selected.bcc = [];

	$scope.toggleCC = () => $scope.isCC = !$scope.isCC;
	$scope.toggleBCC = () => $scope.isBCC = !$scope.isBCC;

	$scope.toggleToolbar = () => $scope.isToolbarShown = !$scope.isToolbarShown;

	$scope.tagClicked = (select, item, model) => {
		const index = model.findIndex(c => c.email == item.email);
		if (index > -1) {
			const tag = item.getTag();
			if (tag) {
				model.splice(index, 1);
				select.search = item.getTag();
			}
		}
	};

	$scope.tagTransform = newTag => {
		if (!newTag)
			return null;

		const match = newTag.match(/<([^>]*)>/);
		const emailInside = match ? match[1] : null;
		const emailTemplate = emailInside ? emailInside : newTag;

		let p = emailTemplate.split('@');

		let name = '', email = '';

		if (p.length > 1)
			[name, email] = [p[0].trim(), `${p[0].trim()}@${p[1].trim()}`];
		else {
			if (!user.settings.isUnknownContactsAutoComplete)
				return null;

			[name, email] = [emailTemplate.trim(), `${emailTemplate.trim()}@${consts.ROOT_DOMAIN}`];
		}

		if (newHiddenContact) {
			if (newHiddenContact.email == email)
				return newHiddenContact;

			newHiddenContact.cancelKeyLoading();
		}

		if (hiddenContacts[email])
			return hiddenContacts[email];

		if (contacts.getContactByEmail(email))
			return null;

		newHiddenContact = new ContactEmail(null, {
			isTag: true,
			tag: newTag,
			name,
			email,
			isNew: true
		}, 'hidden');

		newHiddenContact.loadKey();

		hiddenContacts[newHiddenContact.email] = newHiddenContact;
		return newHiddenContact;
	};

	$scope.personFilter = (text) =>
		(person) => {
			text = text.toLowerCase();

			return person &&
				(!$scope.form || !$scope.form.selected.to.some(e => e.email == person.email)) && (
					person.getDisplayName().toLowerCase().includes(text) ||
					person.name.toLowerCase().includes(text) ||
					person.email.toLowerCase().includes(text)
				);
		};

	$scope.formatPaste = (html) => textAngularHelpers.formatPaste(html);

	$scope.$on('$destroy',  () => {
		$interval.cancel(autoSaveInterval);
	});

	hotkey.registerCustomHotkeys($scope, [
		{
			combo: ['ctrl+enter', 'command+enter'],
			description: 'LAVAMAIL.HOTKEY.SEND_EMAIL',
			callback: (event, key) => {
				event.preventDefault();
				$scope.send();
			}
		}
	], {scope: 'ctrlCompose'});

	textAngularHelpers.ctrlEnterCallback = $scope.send;
};