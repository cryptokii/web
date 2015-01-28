var Buffer = require('buffer/').Buffer;

angular.module(primaryApplicationName).service('user', function($q, $rootScope, $state, $timeout, $window, $translate, consts, apiProxy, LavaboomAPI, co, app, crypto, cryptoKeys, loader) {
	var self = this;

	var translations = {};
	$rootScope.$bind('$translateChangeSuccess', () => {
		translations.LB_BYE = $translate.instant('LOADER.LB_BYE');
	});

	this.name = '';
	this.email = '';
	this.nameEmail = '';

	// information about user from API
	this.settings = {};

	// primary key
	this.key = null;

	var token = sessionStorage.lavaboomToken ? sessionStorage.lavaboomToken : localStorage.lavaboomToken;
	var isAuthenticated = false;

	var setupUserBasicInformation = (username) => {
		self.name = username;
		self.email = `${username}@${consts.ROOT_DOMAIN}`;
		self.nameEmail = `${self.name} <${self.email}>`;
	};

	var persistAuth = (isRemember = true) => {
		var storage = isRemember ? localStorage : sessionStorage;
		storage.lavaboomToken = token;
	};

	this.calculateHash = (password) => (new Buffer(openpgp.crypto.hash.sha256(password), 'binary')).toString('hex');

	if (token)
		LavaboomAPI.setAuthToken(token);

	this.isAuthenticated = () => token && isAuthenticated;

	var syncKeys = () => co(function *(){
		var res = yield apiProxy(['keys', 'list'], self.name);

		var keysByFingerprint = res.body.keys ? res.body.keys.reduce((a, k) => {
			a[k.id] = k;
			return a;
		}, {}) : {};

		var publicKeys = crypto.getAvailablePublicKeysForSourceEmails();

		var keysCreationPromises = [];

		Object.keys(publicKeys).forEach(email => {
			var keysForEmail = publicKeys[email];
			keysForEmail.forEach(key => {
				if (!keysByFingerprint[key.primaryKey.fingerprint]) {
					console.log(`Importing key with fingerprint '${key.primaryKey.fingerprint}' to the server...`);

					keysCreationPromises.push(apiProxy(['keys', 'create'], key.armor()));
				} else
					console.log(`Key with fingerprint '${key.primaryKey.fingerprint}' already imported...`);
			});
		});

		yield keysCreationPromises;
	});

	this.gatherUserInformation = () => co(function * () {
		var res = yield apiProxy(['accounts', 'get'], 'me');

		self.settings = res.body.user.settings ? res.body.user.settings : {};
		$rootScope.$broadcast('user-settings');

		setupUserBasicInformation(res.body.user.name);

		yield syncKeys();

		res = yield apiProxy(['keys', 'get'], self.email);
		self.key = res.body.key;

		if (!isAuthenticated) {
			isAuthenticated = true;
			$rootScope.$broadcast('user-authenticated');
		}

		return res.body;
	});

	this.update = (settings) => {
		angular.extend(self.settings, settings);
		return apiProxy(['accounts', 'update'], 'me', {
			settings: self.settings
		});
	};

	this.signIn = (username, password, isRemember, isPrivateComputer) => {
		setupUserBasicInformation(username);

		crypto.initialize({
			isRememberPasswords: isRemember
		});

		return co(function * (){
			try {
				var res = yield apiProxy(['tokens', 'create'], {
					type: 'auth',
					username: username,
					password: self.calculateHash(password)
				});

				token = res.body.token.id;
				LavaboomAPI.setAuthToken(token);
				persistAuth(isRemember);
				isAuthenticated = true;

				res = yield apiProxy(['keys', 'list'], self.name);
				if (!res.body.keys || res.body.keys.length < 1) {
					$state.go('generateKeys');
					return;
				}

				crypto.options.isPrivateComputer = isPrivateComputer;
				crypto.authenticateDefault(password);

				$rootScope.$broadcast('user-authenticated');
			} catch (err) {
				$rootScope.$broadcast('user-authentication-error', err);
				throw err;
			}
		});
	};

	this.logout = () => {
		if (localStorage.lavaboomToken)
			delete localStorage.lavaboomToken;
		if (sessionStorage.lavaboomToken)
			delete sessionStorage.lavaboomToken;

		loader.resetProgress();
		loader.showLoader(true);
		loader.loadLoginApplication({lbDone: translations.LB_BYE});
	};
});