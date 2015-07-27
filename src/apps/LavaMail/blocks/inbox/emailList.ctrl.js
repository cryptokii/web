module.exports = ($rootScope, $scope, $timeout, $state, $stateParams, $translate, $sanitize,
							   user, utils, co, inbox, saver, notifications, router, Email) => {

	$scope.selfEmail = user.email;
	$scope.labelName = utils.capitalize($state.params.labelName);
	$scope.selectedTid = $stateParams.threadId ? $stateParams.threadId : null;
	inbox.selectedTidByLabelName[$scope.labelName] = $scope.selectedTid;

	$scope.isThreads = false;
	$scope.isLoading = false;

	$rootScope.$bind('notifications', () => {
		$scope.notificationsInfo = angular.extend({},
			notifications.get('info', 'mailbox'),
			notifications.get('info', 'mailbox-' + $scope.selectedTid)
		);
		$scope.notificationsWarning = angular.extend({},
			notifications.get('warning', 'mailbox'),
			notifications.get('warning', 'mailbox-' + $scope.selectedTid)
		);
	});

	{
		let list = inbox.requestListCached($scope.labelName);
		console.log('requestListCached', list);
		$scope.threads = list ? utils.toMap(list) : {};
		$scope.isThreads = Object.keys($scope.threads).length > 0;
	}

	console.log('CtrlEmailList is loading', $scope.labelName, $scope.selectedTid);

	$scope.performEmailAction = () => {
		if ($scope.labelName == 'Drafts')
			router.showPopup('compose', {draftId: $scope.selectedTid});
	};

	$scope.$on(`inbox-threads-ready`, (e, labelName, threads) => {
		$scope.threads = utils.toMap(threads);
		$scope.isThreads = true;
	});

	const translations = {
		TITLE_CONFIRM: '',
		LB_EMAIL_HAS_EMBEDDED_STYLING: ''
	};
	$translate.bindAsObject(translations, 'LAVAMAIL.INBOX');

	$scope.downloadEmail = (email, name, isHtml) => {
		let contentType = isHtml ? 'text/html' : 'text/plain';

		saver.saveAs(email, name + (isHtml ? '.html' : '.txt'), contentType);
	};

	$scope.openEmail = (email, isHtml) => {
		let contentType = isHtml ? 'text/html' : 'text/plain';

		saver.openAs(email, contentType);
	};

	$scope.restoreFromSpam = (tid) => {
		console.log('restoreFromSpam', tid, $scope.threads[tid]);
		inbox.requestRestoreFromSpam($scope.threads[tid]);
	};

	$scope.restoreFromTrash = (tid) => {
		console.log('restoreFromTrash', tid, $scope.threads[tid]);
		inbox.requestRestoreFromTrash($scope.threads[tid]);
	};

	$scope.spamThread = (tid) => {
		console.log('spamThread', tid, $scope.threads[tid]);
		inbox.requestAddLabel($scope.threads[tid], 'Spam');
	};

	$scope.deleteThread = (tid) => {
		console.log('deleteThread', tid, $scope.threads[tid]);

		inbox.requestDelete($scope.threads[tid]);
	};

	$scope.starThread = (tid) => {
		console.log('starThread', tid, $scope.threads[tid]);
		inbox.requestSwitchLabel($scope.threads[tid], 'Starred');
	};

	$scope.$on('inbox-new', (e, threadId) => {
		if (threadId == $scope.selectedTid && $scope.emails.every(e => e.body.state == 'ok'))
			inbox.setThreadReadStatus($scope.selectedTid);
	});

	function transformEmails (emails) {
		console.log(emails);
		return emails.map(e => {
			e.originalBodyData = e.body.data;
			e.displayBodyData = e.body.data;
			return e;
		});
	}

	if ($scope.selectedTid) {
		$scope.emails = [];
		$scope.isLoading = true;
		console.log('emails has selected tid', $scope.selectedTid);

		co(function *() {
			try {
				if ($scope.labelName == 'Drafts') {
					let draft = yield inbox.getDraftById($scope.selectedTid);

					$scope.emails = transformEmails([yield Email.fromDraftFile(draft)]);
				} else {
					let threadPromise = inbox.getThreadById($scope.selectedTid);
					let emailsPromise = inbox.getEmailsByThreadId($scope.selectedTid);

					let thread = yield co.def(threadPromise, null);

					if (!thread || !thread.isLabel($scope.labelName)) {
						inbox.selectedTidByLabelName[$scope.labelName] = null;
						yield $state.go('main.inbox.label', {
							labelName: $scope.labelName.toLowerCase(),
							threadId: null
						});
						return;
					}

					yield utils.wait(() => $scope.isThreads);

					$scope.emails = transformEmails(yield emailsPromise);

					if ($scope.emails.every(e => e.body.state == 'ok'))
						inbox.setThreadReadStatus($scope.selectedTid);
				}
			} finally {
				$scope.isLoading = false;
			}
		});
	}

	$scope.$on('inbox-emails', (e, threadId) => {
		if (threadId != $scope.selectedTid)
			return;

		co(function *() {
			$scope.isLoading = true;
			try {
				if ($scope.labelName == 'Drafts') {
					let draft = yield inbox.getDraftById($scope.selectedTid);

					$scope.emails = transformEmails([yield Email.fromDraftFile(draft)]);
				} else
					$scope.emails = transformEmails(yield inbox.getEmailsByThreadId(threadId));
			} finally {
				$scope.isLoading = false;
			}
		});
	});

	let emailsBeforeSearch = [];

	$scope.$on('inbox-emails-clear', () => {
		emailsBeforeSearch = $scope.emails;
		$scope.emails = [];
	});

	$scope.$on('inbox-emails-restore', () => {
		if (emailsBeforeSearch && emailsBeforeSearch.length > 0) {
			$scope.emails = emailsBeforeSearch;
			emailsBeforeSearch = [];
		}
	});
};