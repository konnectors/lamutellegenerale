import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import { parse, format } from 'date-fns'
import { fr } from 'date-fns/locale'
const log = Minilog('ContentScript')
Minilog.enable('lamutuellegeneraleCCC')

// const baseUrl = 'https://www.lamutuellegenerale.fr/'
const loginFormUrl = 'https://adherent.lamutuellegenerale.fr/'

const personnalInfos = []
const foundBills = []
const foundBillsDetails = []
const base64Pdfs = []
var openProxied = window.XMLHttpRequest.prototype.open
window.XMLHttpRequest.prototype.open = function () {
  var originalResponse = this
  if (arguments[1].includes('/moncompte/infosPersonnelles')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonInfos = JSON.parse(originalResponse.responseText)
        personnalInfos.push(jsonInfos)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  }
  if (arguments[1].includes('/mesremboursements/?debutPeriode')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonBills = JSON.parse(originalResponse.responseText)
        foundBills.push(jsonBills)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  }
  // eslint-disable-next-line no-useless-escape, prettier/prettier
  if (arguments[1].match(/\/mesremboursements\/\d+/g)) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonDetails = JSON.parse(originalResponse.responseText)
        foundBillsDetails.push(jsonDetails)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  }
  if (arguments[1].includes('/mesremboursements/edition?debutPeriode=')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const base64 = JSON.parse(originalResponse.responseText)
        base64Pdfs.push(base64.edition)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  }
  return openProxied.apply(this, [].slice.call(arguments))
}

class LaMutuelleGeneraleContentScript extends ContentScript {
  onWorkerReady() {
    this.log('info', 'onWorkerReady starts')
    window.addEventListener('DOMContentLoaded', () => {
      this.log('info', 'DOMContentLoaded OK')
      const form = document.querySelector('form')
      if (form) {
        form.addEventListener('submit', () => {
          this.log('info', 'Form submit detected, sending credentials')
          const password = document.querySelector('#password')?.value
          const login = document.querySelector('#username')?.value
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { login, password }
          })
        })
      }
      const error = document.querySelector('span[id*="error-element-"]')
      if (error) {
        this.bridge.emit('workerEvent', {
          event: 'loginError',
          payload: { msg: error.innerHTML }
        })
      }
    })
  }

  onWorkerEvent({ event, payload }) {
    this.log('info', 'onWorkerEvent starts')
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
      // this.log(
      //   'info',
      //   `{event payload} : ${JSON.stringify({ event, payload })}`
      // )
      const { login, password } = payload || {}
      if (login && password) {
        // On this website you could use your adherent number or your mail.
        // We just follow de convention to save an "email"
        // into the keyChain so there is no confusion when manipulating this credentials later
        const email = login
        // this.log(
        //   'info',
        //   `workerEvent {email, password} : ${JSON.stringify({
        //     email,
        //     password
        //   })}`
        // )
        this.saveCredentials({ email, password })
      }
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(loginFormUrl)
    await Promise.race([
      this.waitForElementInWorker('#password'),
      this.waitForElementInWorker('a[analyticsbuttonlabel="Déconnexion"]')
    ])
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    // Mandatory, or else the loginForm wont display saying the browser's version is not appropriate
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (Linux; Android 11; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Mobile Safari/537.36'
    )
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    if (!(await this.isElementInWorker('#password'))) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
    }
    this.log('info', 'Authenticated, unblocking worker interactions')
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    await this.clickAndWait(
      'a[analyticsbuttonlabel="Déconnexion"]',
      '#password'
    )
  }

  async checkAuthenticated() {
    this.log('info', '🤖 checkAuthenticated')
    return Boolean(
      document.querySelector('a[analyticsbuttonlabel="Déconnexion"]')
    )
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.clickAndWait(
      'a[href="/mes-informations-personnelles"]',
      '.personal-information-banner'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterceptions',
      args: ['personnalInfos']
    })
    await this.runInWorker('getIdentity')
    if (this.store.userIdentity) {
      return { sourceAccountIdentifier: this.store.userIdentity.email }
    } else {
      throw new Error(
        'No source account identifier, the konnector should be fixed'
      )
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    await this.clickAndWait(
      'a[href="/remboursements"]',
      'app-refunds-list-block'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterceptions',
      args: ['bills']
    })
    const numberOfMonths = await this.evaluateInWorker(
      function getNumberOfMonths() {
        const numberfMonthsBlocks = document.querySelectorAll(
          'app-refunds-list-block'
        ).length
        return numberfMonthsBlocks
      }
    )
    for (let i = 0; i < numberOfMonths; i++) {
      const { monthReimbursments, dataUri } = await this.runInWorker(
        'findReimbursments',
        i
      )
      for (const monthReimbursment of monthReimbursments) {
        const { detailedData, acts, sharedFileInfos } = await this.runInWorker(
          'getDetails',
          monthReimbursment,
          dataUri
        )
        for (let i = 0; i < acts.length; i++) {
          const oneBill = await this.runInWorker(
            'getBill',
            detailedData,
            sharedFileInfos,
            i
          )
          await this.saveBills([oneBill], {
            context,
            contentType: 'application/pdf',
            fileIdAttributes: ['filename', 'fileurl'],
            qualificationLabel: 'health_invoice'
          })
        }
      }
    }
  }

  async checkInterceptions(option) {
    this.log('info', '📍️ checkInterceptions starts')
    await waitFor(
      () => {
        if (option === 'personnalInfos') {
          return Boolean(personnalInfos.length > 0)
        }
        if (option === 'bills') {
          return Boolean(foundBills.length > 0)
        }
        if (option === 'details') {
          return Boolean(foundBillsDetails.length > 0)
        }
        if (option === 'pdf') {
          return Boolean(base64Pdfs.length > 0)
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    this.log('info', `Interception for ${option} - OK`)
    return true
  }

  async getIdentity() {
    this.log('info', '📍️ getIdentity starts')
    const infos = personnalInfos[0].informationsPersonnelles.profil
    const address = this.getAddress(infos.coordonneesContact.adresse)
    const phone = this.getPhones()
    const userIdentity = {
      email: infos.coordonneesContact.email,
      birthDate: infos.dateNaissance,
      name: {
        givenName: infos.prenom,
        familyName: infos.nom
      },
      address
    }
    if (phone.length > 0) {
      userIdentity.phone = phone
    } else {
      this.log('info', 'getIdentity - No phone number found')
    }
    await this.sendToPilot({ userIdentity })
  }

  getAddress(addressInfos) {
    this.log('info', '📍️ getAddress starts')
    let address = {}
    let formattedAddress = ''
    const userAddress = []
    if (addressInfos.numVoie) {
      formattedAddress = `${addressInfos.numVoie} `
      address.streetNumber = addressInfos.numVoie
    }
    if (addressInfos.btq) {
      formattedAddress = `${formattedAddress}${addressInfos.btq} `
      address.building = addressInfos.btq
    }
    if (addressInfos.pointRemise) {
      formattedAddress = `${formattedAddress}${addressInfos.pointRemise} `
      address.dropOffPoint = addressInfos.pointRemise
    }
    if (addressInfos.voie) {
      formattedAddress = `${formattedAddress}${addressInfos.voie} `
      address.street = addressInfos.voie
    }
    if (addressInfos.complement) {
      formattedAddress = `${formattedAddress}${addressInfos.complement} `
      address.complement = addressInfos.complement
    }
    if (addressInfos.lieuDit) {
      formattedAddress = `${formattedAddress}${addressInfos.lieuDit} `
      address.locality = addressInfos.lieuDit
    }
    if (addressInfos.codePostal) {
      formattedAddress = `${formattedAddress}${addressInfos.codePostal} `
      address.postCode = addressInfos.codePostal
    }
    if (addressInfos.ville) {
      formattedAddress = `${formattedAddress}${addressInfos.ville} `
      address.city = addressInfos.ville
    }
    if (addressInfos.pays) {
      formattedAddress = `${formattedAddress}${addressInfos.pays} `
      address.country = addressInfos.pays
    }
    address.formattedAddress = formattedAddress
    userAddress.push(address)
    return userAddress
  }

  // The account we have to develop this konnector didn't fill his phones information
  // So for now we scrap it on the page as it's visible, but not present in the intercepted JSON
  // This probably appears with the rest of the JSONinfos when filled, but for now we cannot tell for sure.
  getPhones() {
    this.log('info', '📍️ getPhones starts')
    const phone = []
    const infosElements = document.querySelectorAll('.card')
    for (const infosElement of infosElements) {
      const elementTitle = infosElement.querySelector('h3').textContent
      if (elementTitle === 'Email et téléphone') {
        for (const info of infosElement.querySelectorAll('div > p')) {
          if (
            info.textContent.includes('fixe') &&
            !info.textContent.includes('À renseigner')
          ) {
            this.log('info', 'Home number found')
            phone.push({
              type: 'home',
              number: info.textContent.split(':')[1]
            })
          }
          if (
            info.textContent.includes('mobile') &&
            !info.textContent.includes('À renseigner')
          ) {
            this.log('info', 'Mobile number found')
            phone.push({
              type: 'home',
              number: info.textContent.split(':')[1]
            })
          }
        }
      }
    }
    return phone
  }

  async findReimbursments(i) {
    this.log('info', '📍️ findReimbursments starts')
    const billsInfos = foundBills[0].remboursements
    const monthBlocks = document.querySelectorAll('app-refunds-list-block')
    let monthReimbursments = this.getMonthReimbursments(
      monthBlocks[i],
      billsInfos
    )
    monthBlocks[i]
      .querySelector('.app-refund-block__title-download-button')
      .click()
    await this.checkInterceptions('pdf')
    const dataUri = `data:application/pdf;base64,${base64Pdfs[0]}`
    // Resetting this array to ensure the next interception will be the first in the array
    base64Pdfs.length = 0
    return { monthReimbursments, dataUri }
  }

  async getDetails(monthReimbursment, dataUri) {
    this.log('info', '📍️ getDetails starts')
    document
      .querySelector(`div[id="${monthReimbursment.id}"]`)
      .querySelector('.icon-chevron-remboursement')
      .click()
    await this.checkInterceptions('details')
    const detailedData = {
      sharedActsInfos: { ...monthReimbursment },
      ...foundBillsDetails[0].remboursement
    }
    // Resetting this array to ensure the next interception will be the first in the array
    foundBillsDetails.length = 0
    const acts = detailedData.actes
    const careDate = detailedData.sharedActsInfos.dateSoin
    const filename = `${careDate.substring(
      0,
      7
    )}_ReleveMensuel_LaMutuelleGenerale.pdf`
    const sharedFileInfos = {
      dataUri,
      filename
    }
    return { detailedData, acts, sharedFileInfos }
  }

  async getBill(detailedData, sharedFileInfos, i) {
    this.log('info', '📍️ getBill starts')
    const oneBill = {
      dataUri: sharedFileInfos.dataUri,
      vendorRef: `${detailedData.id}_${i}`,
      beneficiary: `${detailedData.sharedActsInfos.prenomAssure} ${detailedData.sharedActsInfos.nomAssure}`,
      date: new Date(detailedData.sharedActsInfos.datePaiement),
      isThirdPartyPayer: detailedData.tiersPayant,
      groupAmount: detailedData.montantVerseLMG,
      originalDate: new Date(detailedData.sharedActsInfos.dateSoin),
      subtype: detailedData.sharedActsInfos.categorieSoin,
      originalAmount: detailedData.actes[i].montantPaye,
      socialSecurityRefund: detailedData.actes[i].montantVerseRO,
      amount: detailedData.actes[i].montantVerseLMG,
      filename: sharedFileInfos.filename,
      vendor: 'lamutuellegenerale',
      type: 'health_costs',
      currency: '€',
      isRefund: true,
      fileAttributes: {
        metadata: {
          contentAuthor: 'lamutuellegenerale.fr',
          issueDate: new Date(),
          datetime: new Date(detailedData.sharedActsInfos.datePaiement),
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
    }
    this.log('info', `oneBill : ${JSON.stringify(oneBill)}`)

    return oneBill
  }

  getMonthReimbursments(element, billsInfos) {
    this.log('info', '📍️ getMonthReimbursments starts')
    const monthReimbursments = []
    const currentMonth = element
      .querySelector('.app-refund-block__title-month')
      .textContent.trim()
      .replace('  ', ' ')
    const parsedDate = parse(currentMonth, 'MMMM yyyy', new Date(), {
      locale: fr
    })
    const formattedDate = format(parsedDate, 'yyyy-MM')
    for (const billInfos of billsInfos) {
      if (billInfos.dateSoin.includes(formattedDate)) {
        monthReimbursments.push(billInfos)
      }
    }
    return monthReimbursments
  }
}

const connector = new LaMutuelleGeneraleContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'checkInterceptions',
      'getIdentity',
      'findReimbursments',
      'getDetails',
      'getBill'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
